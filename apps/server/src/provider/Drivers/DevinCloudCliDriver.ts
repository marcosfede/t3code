import { DevinCloudCliSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDevinCloudTextGeneration } from "../../textGeneration/DevinCloudTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { checkDevinCloudCliProviderStatus } from "../Layers/DevinCloudCliProvider.ts";
import {
  buildInitialDevinCloudProviderSnapshot,
  enrichDevinCloudSnapshot,
  makeDevinCloudModelDiscovery,
} from "../Layers/DevinCloudProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeDevinCloudCliAcpRuntime } from "../acp/DevinCloudCliAcpSupport.ts";
import { resolveDevinCloudOrganizationId } from "../acp/DevinCloudAcpSupport.ts";
import type { DevinDriverEnv } from "./DevinDriver.ts";

const decodeSettings = Schema.decodeSync(DevinCloudCliSettings);
const DRIVER_KIND = ProviderDriverKind.make("devinCloudCli");
const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type DevinCloudCliDriverEnv = DevinDriverEnv;

export const DevinCloudCliDriver: ProviderDriver<DevinCloudCliSettings, DevinCloudCliDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Devin Cloud (CLI)",
    supportsMultipleInstances: true,
  },
  configSchema: DevinCloudCliSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        displayName: displayName || "Devin Cloud (CLI)",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const effectiveConfig = { ...config, enabled } satisfies DevinCloudCliSettings;
      const modelDiscovery = yield* makeDevinCloudModelDiscovery(
        effectiveConfig.customModels,
        effectiveConfig.organizationId,
      );
      const makeAcpRuntime = (input: Parameters<typeof makeDevinCloudCliAcpRuntime>[0]) =>
        makeDevinCloudCliAcpRuntime(input).pipe(Effect.map(modelDiscovery.observeRuntime));
      const adapter = yield* makeDevinAdapter(null, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        provider: DRIVER_KIND,
        makeAcpRuntime: (input) => {
          const organizationId = resolveDevinCloudOrganizationId(
            input.providerOptions,
            effectiveConfig.organizationId,
          );
          return makeAcpRuntime({
            ...input,
            settings: organizationId ? { ...effectiveConfig, organizationId } : effectiveConfig,
          });
        },
      });
      const checkProvider = checkDevinCloudCliProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DevinCloudCliSettings>
      >({
        resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialDevinCloudProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichDevinCloudSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Devin Cloud CLI snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const discoverOrganizations = Effect.gen(function* () {
        const runtime = yield* makeAcpRuntime({
          settings: effectiveConfig,
          environment: processEnv,
          childProcessSpawner: spawner,
          cwd: process.cwd(),
          clientInfo: { name: "t3-code-provider-settings", version: "0.0.0" },
        });
        yield* modelDiscovery.discover(runtime);
      }).pipe(Effect.scoped, Effect.timeout("30 seconds"));

      const decoratedSnapshot = modelDiscovery.decorate(snapshot);
      // Discover the org list eagerly once the provider is ready so fresh
      // threads see the selector without a session or a Settings refresh.
      // `session/new` on `devin acp --cloud` is a draft, not a listed session.
      const discoveryInFlight = yield* Ref.make(false);
      yield* Stream.runForEach(
        Stream.concat(
          Stream.fromEffect(decoratedSnapshot.getSnapshot),
          decoratedSnapshot.streamChanges,
        ),
        (next) =>
          Effect.gen(function* () {
            if (next.status !== "ready" || (yield* modelDiscovery.hasOrganizations)) {
              return;
            }
            const shouldRun = yield* Ref.modify(discoveryInFlight, (inFlight) => [!inFlight, true]);
            if (!shouldRun) {
              return;
            }
            yield* discoverOrganizations.pipe(
              Effect.ensuring(Ref.set(discoveryInFlight, false)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Devin Cloud organization discovery failed", {
                  errorTag: causeErrorTag(cause),
                }),
              ),
            );
          }),
      ).pipe(Effect.forkScoped);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: decoratedSnapshot,
        adapter,
        textGeneration: makeDevinCloudTextGeneration(),
        refreshModels: () =>
          discoverOrganizations.pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "Could not load Devin Cloud organizations. Check the provider sign-in and try again.",
                  cause,
                }),
              ),
            ),
            Effect.provideService(Crypto.Crypto, crypto),
          ),
      } satisfies ProviderInstance;
    }),
};
