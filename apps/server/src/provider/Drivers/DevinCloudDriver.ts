import { DevinCloudSettings } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import type * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeDevinCloudTextGeneration } from "../../textGeneration/DevinCloudTextGeneration.ts";
import {
  DEVIN_CLOUD_PROVIDER,
  makeDevinCloudAdapterV2FromServices,
  type DevinCloudAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/DevinCloudAdapterV2.ts";
import {
  discoverDevinCloudConfigOptions,
  listDevinCloudSessions,
  makeDevinCloudAcpRuntime,
} from "../acp/DevinCloudAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
  makeDevinCloudCatalog,
} from "../Layers/DevinCloudProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeDevinCloudSettings = Schema.decodeSync(DevinCloudSettings);
const DRIVER_KIND = DEVIN_CLOUD_PROVIDER;
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type DevinCloudDriverEnv =
  | DevinCloudAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const DevinCloudDriver: ProviderDriver<DevinCloudSettings, DevinCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Devin Cloud",
    supportsMultipleInstances: true,
  },
  configSchema: DevinCloudSettings,
  defaultConfig: (): DevinCloudSettings => decodeDevinCloudSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const { instanceId, displayName, accentColor, environment, enabled, config } = input;
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const { cwd } = yield* ServerConfig.ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies DevinCloudSettings;
      const catalog = yield* makeDevinCloudCatalog(effectiveConfig);
      const driverError = (detail: string) => (cause: unknown) =>
        new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail, cause });

      const orchestrationAdapter = yield* makeDevinCloudAdapterV2FromServices(input, {
        onConfigOptions: catalog.onConfigOptions,
      }).pipe(Effect.mapError(driverError("Failed to build Devin Cloud orchestration adapter.")));

      const withRuntime = <A, E>(
        clientName: string,
        use: (
          runtime: Effect.Success<ReturnType<typeof makeDevinCloudAcpRuntime>>,
        ) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          const runtime = yield* makeDevinCloudAcpRuntime({
            settings: effectiveConfig,
            environment: processEnv,
            childProcessSpawner: spawner,
            cwd,
            clientInfo: { name: clientName, version: "0.0.0" },
          });
          return yield* use(runtime);
        }).pipe(Effect.scoped, Effect.provideService(Crypto.Crypto, crypto));

      const checkProvider = checkDevinCloudProviderStatus(effectiveConfig, processEnv, cwd).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const managedSnapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<DevinCloudSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialDevinCloudProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError((cause) =>
          driverError(`Failed to build Devin Cloud snapshot: ${cause.message ?? String(cause)}`)(
            cause,
          ),
        ),
      );
      const snapshot = catalog.decorate(managedSnapshot);

      const discoverCatalog = withRuntime("t3-code-provider-settings", (runtime) =>
        discoverDevinCloudConfigOptions(runtime).pipe(Effect.flatMap(catalog.onConfigOptions)),
      ).pipe(Effect.timeout("30 seconds"));

      // Load the organization list once the provider is ready so a fresh
      // thread shows the selector before any Cloud session exists.
      const discoveryInFlight = yield* Ref.make(false);
      yield* Stream.runForEach(
        Stream.concat(Stream.fromEffect(snapshot.getSnapshot), snapshot.streamChanges),
        (next) =>
          Effect.gen(function* () {
            if (next.status !== "ready" || (yield* catalog.hasOrganizations)) return;
            const shouldRun = yield* Ref.modify(discoveryInFlight, (inFlight) => [!inFlight, true]);
            if (!shouldRun) return;
            yield* discoverCatalog.pipe(
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
        snapshot,
        orchestrationAdapter,
        textGeneration: makeDevinCloudTextGeneration(),
        refreshModels: () =>
          discoverCatalog.pipe(
            Effect.mapError(
              driverError(
                "Could not load Devin Cloud organizations. Check the provider sign-in and try again.",
              ),
            ),
          ),
        devinCloudSessions: {
          list: withRuntime("t3-code-session-list", listDevinCloudSessions).pipe(
            Effect.timeout("45 seconds"),
            Effect.mapError(driverError("Could not list Devin Cloud sessions.")),
          ),
        },
      } satisfies ProviderInstance;
    }),
};
