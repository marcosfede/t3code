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
import * as Crypto from "effect/Crypto";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";
import { HttpClient } from "effect/unstable/http";
import { createModelCapabilities } from "@t3tools/shared/model";
import { parseDevinAuthStatus, runDevinCliCommand } from "./DevinProvider.ts";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE,
  DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
  makeDevinCloudAcpRuntime,
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
    slug: "devin-2-5",
    name: "Normal",
    aliases: [DEVIN_CLOUD_DEFAULT_MODEL],
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  { slug: "devin-fast-opus", name: "Fast", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "devin-ultra", name: "Ultra", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "devin_lite", name: "Lite", isCustom: false, capabilities: EMPTY_CAPABILITIES },
  { slug: "devin-auto", name: "Fusion", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];

function devinCloudModels(
  customModels: DevinCloudSettings["customModels"] | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(DEFAULT_CLOUD_MODELS, customModels ?? [], EMPTY_CAPABILITIES);
}

export const makeDevinCloudModelDiscovery = Effect.fn("makeDevinCloudModelDiscovery")(function* (
  customModels: DevinCloudSettings["customModels"],
  settingsOrganizationId: string | undefined,
) {
  const catalog = yield* SubscriptionRef.make<{
    readonly models?: ReadonlyArray<ServerProviderModel>;
    readonly organizations?: ServerProvider["organizations"];
    readonly defaultOrganizationId?: string | undefined;
  }>({});
  const onSessionSetup = (
    setup: Parameters<typeof buildDevinDiscoveredModelsFromSessionSetup>[0],
  ) => {
    const modelOption = findDevinModelConfigOption(setup);
    const orgOption = setup.configOptions?.find((option) => option.id === "org_id");
    return SubscriptionRef.update(catalog, (previous) => ({
      ...previous,
      ...(modelOption ? { models: buildDevinDiscoveredModelsFromSessionSetup(setup) } : {}),
      ...(orgOption?.type === "select"
        ? {
            defaultOrganizationId: orgOption.currentValue.trim() || undefined,
            organizations: orgOption.options
              .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
              .filter((option) => option.value.trim().length > 0)
              .map((option) => ({
                id: option.value.trim(),
                name: option.name.trim() || option.value.trim(),
              })),
          }
        : {}),
    }));
  };
  const applyModels = (snapshot: ServerProvider) =>
    SubscriptionRef.get(catalog).pipe(
      Effect.map((discovered) => {
        const configuredOrganizationId = settingsOrganizationId?.trim();
        const defaultOrganizationId =
          configuredOrganizationId &&
          discovered.organizations?.some((org) => org.id === configuredOrganizationId)
            ? configuredOrganizationId
            : discovered.defaultOrganizationId;
        const organizationDescriptor =
          discovered.organizations && discovered.organizations.length > 0
            ? buildSelectOptionDescriptor({
                id: DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
                label: "Organization",
                description:
                  "Organization that owns this thread's Devin Cloud session. Fixed once the session starts.",
                lockedAfterSessionStart: true,
                options: discovered.organizations.map((org) => ({
                  value: org.id,
                  label: org.name,
                  isDefault: org.id === defaultOrganizationId,
                })),
              })
            : undefined;
        const models = discovered.models
          ? providerModelsFromSettings(
              discovered.models.length > 0 ? discovered.models : DEFAULT_CLOUD_MODELS,
              customModels,
              EMPTY_CAPABILITIES,
            )
          : snapshot.models;
        return {
          ...snapshot,
          ...(discovered.organizations ? { organizations: discovered.organizations } : {}),
          ...(discovered.models || organizationDescriptor
            ? {
                models: organizationDescriptor
                  ? models.map((model) => ({
                      ...model,
                      capabilities: createModelCapabilities({
                        optionDescriptors: [
                          ...(model.capabilities?.optionDescriptors ?? []),
                          organizationDescriptor,
                        ],
                      }),
                    }))
                  : models,
              }
            : {}),
        };
      }),
    );

  return {
    onSessionSetup,
    hasOrganizations: SubscriptionRef.get(catalog).pipe(
      Effect.map((discovered) => discovered.organizations !== undefined),
    ),
    discover: Effect.fn("DevinCloudModelDiscovery.discover")(function* (
      runtime: AcpSessionRuntime["Service"],
    ) {
      yield* runtime.initialize();
      const setup = yield* runtime
        .request("session/new", { cwd: process.cwd(), mcpServers: [] })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AcpSchema.NewSessionResponse)));
      yield* onSessionSetup(setup);
    }),
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
          SubscriptionRef.changes(catalog).pipe(Stream.mapEffect(() => getSnapshot)),
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
const probeDevinCloudAcp = (cloudSettings: DevinCloudSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const acp = yield* makeDevinCloudAcpRuntime({
      cloudSettings,
      environment,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    return yield* acp.initialize();
  }).pipe(
    Effect.scoped,
    Effect.retry({ times: 2, schedule: Schedule.spaced("1 second"), while: isConnectionLost }),
  );

export const checkDevinCloudProviderStatus = Effect.fn("checkDevinCloudProviderStatus")(function* (
  cloudSettings: DevinCloudSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = devinCloudModels(cloudSettings.customModels);

  const snapshot = (probe: ProviderProbeResult) =>
    buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: cloudSettings.enabled,
      checkedAt,
      models,
      probe,
    });
  if (!cloudSettings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Devin Cloud is disabled in T3 Code settings.",
    });
  }
  if (cloudSettings.credentialsPath?.trim()) {
    return snapshot({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE,
    });
  }
  const versionResult = yield* runDevinCliCommand(cloudSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(4_000),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return snapshot({
      installed: !isCommandMissingCause(versionResult.failure),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Could not execute the Devin CLI. Install a version supporting `acp --cloud` and check the configured Binary path.",
    });
  }
  if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "The Devin CLI failed or timed out while running `--version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  const authResult = yield* runDevinCliCommand(cloudSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(4_000),
    Effect.result,
  );
  const auth =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? parseDevinAuthStatus(
          `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`,
        )
      : { status: "unknown" as const };
  if (auth.status === "unauthenticated") {
    return snapshot({
      installed: true,
      version,
      status: "warning",
      auth,
      message: "Sign in with a Devin account using the configured binary's `auth login` command.",
    });
  }

  const probeExit = yield* probeDevinCloudAcp(cloudSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_CLOUD_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(probeExit)) {
    yield* Effect.logWarning("Devin Cloud ACP probe failed", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Could not initialize `acp --cloud`. Update the configured Devin CLI, sign in with a Devin account using `auth login`, and check network access.",
    });
  }
  if (Option.isNone(probeExit.value)) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `Devin Cloud ACP probe timed out after ${DEVIN_CLOUD_ACP_PROBE_TIMEOUT_MS}ms.`,
    });
  }

  return snapshot({
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
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
