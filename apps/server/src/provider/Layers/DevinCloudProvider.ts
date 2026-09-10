import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  type DevinCloudSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as EffectAcpClient from "effect-acp/client";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { connectAcpWebSocketStdio } from "../acp/AcpWebSocketStdio.ts";
import {
  buildDevinCloudAcpWebSocketUrl,
  loadDevinCloudCredentials,
} from "../acp/DevinCloudAcpSupport.ts";
import { isConnectionLost } from "../acp/DevinCloudReconnect.ts";
import { findDevinModelConfigOption } from "../acp/DevinAcpSupport.ts";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import { buildDevinDiscoveredModelsFromSessionSetup } from "./DevinProvider.ts";

const DEVIN_CLOUD_PRESENTATION = {
  displayName: "Devin Cloud",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const DEVIN_CLOUD_ACP_PROBE_TIMEOUT_MS = 10_000;

const DEFAULT_CLOUD_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_CLOUD_DEFAULT_MODEL,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function devinCloudModels(
  customModels: DevinCloudSettings["customModels"] | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(DEFAULT_CLOUD_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

export const makeDevinCloudModelDiscovery = Effect.fn("makeDevinCloudModelDiscovery")(function* (
  customModels: DevinCloudSettings["customModels"],
) {
  const models = yield* SubscriptionRef.make<ReadonlyArray<ServerProviderModel> | undefined>(
    undefined,
  );
  const onSessionSetup = (
    setup: Parameters<typeof buildDevinDiscoveredModelsFromSessionSetup>[0],
  ) => {
    if (!findDevinModelConfigOption(setup)) return Effect.void;
    return SubscriptionRef.set(models, buildDevinDiscoveredModelsFromSessionSetup(setup));
  };
  const applyModels = (snapshot: ServerProvider) =>
    SubscriptionRef.get(models).pipe(
      Effect.map((discovered) =>
        discovered === undefined
          ? snapshot
          : {
              ...snapshot,
              models: providerModelsFromSettings(
                discovered.length > 0 ? discovered : DEFAULT_CLOUD_MODELS,
                customModels,
                EMPTY_CAPABILITIES,
              ),
            },
      ),
    );

  return {
    onSessionSetup,
    observeRuntime: (runtime: AcpSessionRuntime["Service"]): AcpSessionRuntime["Service"] => ({
      ...runtime,
      start: () =>
        runtime.start().pipe(Effect.tap((started) => onSessionSetup(started.sessionSetupResult))),
      getEvents: () =>
        runtime
          .getEvents()
          .pipe(
            Stream.tap((event) =>
              event._tag === "ConfigOptionsUpdated"
                ? onSessionSetup({ configOptions: [...event.configOptions] })
                : Effect.void,
            ),
          ),
    }),
    decorate: (source: ServerProviderShape): ServerProviderShape => {
      const getSnapshot = source.getSnapshot.pipe(Effect.flatMap(applyModels));
      return {
        ...source,
        getSnapshot,
        refresh: source.refresh.pipe(Effect.flatMap(applyModels)),
        streamChanges: Stream.merge(
          source.streamChanges.pipe(Stream.mapEffect(applyModels)),
          SubscriptionRef.changes(models).pipe(Stream.mapEffect(() => getSnapshot)),
        ).pipe(Stream.changesWith((previous, next) => Equal.equals(previous, next))),
      };
    },
  };
});

export function buildInitialDevinCloudProviderSnapshot(
  cloudSettings: DevinCloudSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinCloudModels(cloudSettings.customModels);

    if (!cloudSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_CLOUD_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin Cloud is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin Cloud availability...",
      },
    });
  });
}

/** Connects to the cloud ACP relay and performs `initialize` only — never
 * `session/new`, which would create a real cloud session per probe. A verdict
 * stands until the next health refresh, so a dropped handshake is retried
 * rather than reported as an outage while live sessions reconnect fine. */
const probeDevinCloudAcp = (webSocketUrl: string) =>
  Effect.gen(function* () {
    const stdioHandle = yield* connectAcpWebSocketStdio(webSocketUrl);
    const acpContext = yield* Layer.build(
      Layer.effect(
        EffectAcpClient.AcpClient,
        EffectAcpClient.make(stdioHandle.stdio, {}, stdioHandle.terminationError),
      ),
    );
    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));
    return yield* acp.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
  }).pipe(
    Effect.scoped,
    Effect.retry({ times: 2, schedule: Schedule.spaced("1 second"), while: isConnectionLost }),
  );

export const checkDevinCloudProviderStatus = Effect.fn("checkDevinCloudProviderStatus")(function* (
  cloudSettings: DevinCloudSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, FileSystem.FileSystem> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = devinCloudModels(cloudSettings.customModels);

  if (!cloudSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin Cloud is disabled in T3 Code settings.",
      },
    });
  }

  const credentialsResult = yield* loadDevinCloudCredentials(cloudSettings, environment).pipe(
    Effect.result,
  );
  if (Result.isFailure(credentialsResult)) {
    const message = credentialsResult.failure.message;
    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: cloudSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unauthenticated" },
        message,
      },
    });
  }

  const probeExit = yield* probeDevinCloudAcp(
    buildDevinCloudAcpWebSocketUrl(credentialsResult.success),
  ).pipe(Effect.timeoutOption(DEVIN_CLOUD_ACP_PROBE_TIMEOUT_MS), Effect.exit);

  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Devin Cloud ACP probe failed", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: cloudSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Could not reach the Devin Cloud ACP endpoint. Check network access and `devin auth login`.",
      },
    });
  }
  if (Option.isNone(probeExit.value)) {
    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: cloudSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Devin Cloud ACP probe timed out after ${DEVIN_CLOUD_ACP_PROBE_TIMEOUT_MS}ms.`,
      },
    });
  }

  const agentVersion = probeExit.value.value.agentInfo?.version?.trim() || null;
  return buildServerProvider({
    presentation: DEVIN_CLOUD_PRESENTATION,
    enabled: cloudSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: agentVersion,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichDevinCloudSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin Cloud version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
