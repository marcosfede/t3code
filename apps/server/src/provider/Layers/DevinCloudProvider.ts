import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  type DevinCloudSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpSchema from "effect-acp/compat";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE,
  DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
  devinCloudCatalogFromConfigOptions,
  type DevinCloudConfigCatalog,
  makeDevinCloudAcpRuntime,
} from "../acp/DevinCloudAcpSupport.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const DEVIN_CLOUD_PRESENTATION = {
  displayName: "Devin Cloud",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const CLI_PROBE_TIMEOUT_MS = 4_000;
const ACP_PROBE_TIMEOUT_MS = 10_000;

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
  builtInModels: ReadonlyArray<ServerProviderModel> = DEFAULT_CLOUD_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Applies the models and organizations live Cloud sessions advertise to a snapshot. */
export function applyDevinCloudCatalog(
  snapshot: ServerProvider,
  catalog: DevinCloudConfigCatalog,
  settings: Pick<DevinCloudSettings, "customModels" | "organizationId">,
): ServerProvider {
  const configuredOrganizationId = settings.organizationId?.trim();
  const defaultOrganizationId =
    configuredOrganizationId &&
    catalog.organizations?.some((organization) => organization.id === configuredOrganizationId)
      ? configuredOrganizationId
      : catalog.defaultOrganizationId;
  const organizationDescriptor =
    catalog.organizations && catalog.organizations.length > 0
      ? buildSelectOptionDescriptor({
          id: DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
          label: "Organization",
          description:
            "Organization that owns this thread's Devin Cloud session. Fixed once the session starts.",
          lockedAfterSessionStart: true,
          options: catalog.organizations.map((organization) => ({
            value: organization.id,
            label: organization.name,
            isDefault: organization.id === defaultOrganizationId,
          })),
        })
      : undefined;
  const discoveredModels =
    catalog.models && catalog.models.length > 0
      ? catalog.models.map((model): ServerProviderModel => ({
          slug: model.slug,
          name: model.name,
          isCustom: false,
          ...(model.slug === (catalog.currentModel ?? catalog.models![0]!.slug)
            ? { isDefault: true, aliases: [DEVIN_CLOUD_DEFAULT_MODEL] }
            : {}),
          capabilities: EMPTY_CAPABILITIES,
        }))
      : undefined;
  const models = discoveredModels
    ? devinCloudModels(settings.customModels, discoveredModels)
    : snapshot.models;
  if (!discoveredModels && !organizationDescriptor) return snapshot;
  return {
    ...snapshot,
    ...(catalog.organizations ? { organizations: catalog.organizations } : {}),
    models: organizationDescriptor
      ? models.map((model) => ({
          ...model,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              ...(model.capabilities?.optionDescriptors ?? []).filter(
                (descriptor) => descriptor.id !== DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
              ),
              organizationDescriptor,
            ],
          }),
        }))
      : models,
  };
}

/** Holds the Cloud model and organization pickers last seen on a live or draft session. */
export const makeDevinCloudCatalog = Effect.fn("makeDevinCloudCatalog")(function* (
  settings: Pick<DevinCloudSettings, "customModels" | "organizationId">,
) {
  const catalog = yield* SubscriptionRef.make<DevinCloudConfigCatalog>({});
  const apply = (snapshot: ServerProvider) =>
    Effect.map(SubscriptionRef.get(catalog), (current) =>
      applyDevinCloudCatalog(snapshot, current, settings),
    );
  return {
    onConfigOptions: (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
      SubscriptionRef.update(catalog, (previous) => ({
        ...previous,
        ...devinCloudCatalogFromConfigOptions(configOptions),
      })),
    hasOrganizations: Effect.map(
      SubscriptionRef.get(catalog),
      (current) => current.organizations !== undefined,
    ),
    decorate: (source: ServerProviderShape): ServerProviderShape => {
      const getSnapshot = source.getSnapshot.pipe(Effect.flatMap(apply));
      return {
        ...source,
        getSnapshot,
        refresh: source.refresh.pipe(Effect.flatMap(apply)),
        streamChanges: Stream.merge(
          source.streamChanges.pipe(Stream.mapEffect(apply)),
          SubscriptionRef.changes(catalog).pipe(
            Stream.drop(1),
            Stream.mapEffect(() => getSnapshot),
          ),
        ),
      };
    },
  };
});

export function buildInitialDevinCloudProviderSnapshot(
  settings: DevinCloudSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: devinCloudModels(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Devin Cloud availability..."
          : "Devin Cloud is disabled in T3 Code settings.",
      },
    });
  });
}

export const runDevinCliCommand = (
  settings: Pick<DevinCloudSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/** Parses `devin auth status`, which prints "Not logged in." or "Logged in as …". */
export function parseDevinAuthStatus(output: string): ServerProviderAuth {
  const normalized = output.toLowerCase();
  if (normalized.includes("not logged in")) return { status: "unauthenticated" };
  if (normalized.includes("logged in")) return { status: "authenticated" };
  return { status: "unknown" };
}

/**
 * Checks the CLI, its sign-in, and an ACP `initialize` against the Cloud
 * relay. Never sends `session/new` during health checks.
 */
export const checkDevinCloudProviderStatus = Effect.fn("checkDevinCloudProviderStatus")(function* (
  settings: DevinCloudSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (probe: ProviderProbeResult) =>
    buildServerProvider({
      presentation: DEVIN_CLOUD_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: devinCloudModels(settings.customModels),
      probe,
    });
  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Devin Cloud is disabled in T3 Code settings.",
    });
  }
  if (settings.credentialsPath?.trim()) {
    return snapshot({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE,
    });
  }
  const versionResult = yield* runDevinCliCommand(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(CLI_PROBE_TIMEOUT_MS),
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
  const authResult = yield* runDevinCliCommand(settings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(CLI_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const auth =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? parseDevinAuthStatus(
          `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`,
        )
      : ({ status: "unknown" } as const);
  if (auth.status === "unauthenticated") {
    return snapshot({
      installed: true,
      version,
      status: "warning",
      auth,
      message: "Sign in with a Devin account using the configured binary's `auth login` command.",
    });
  }
  const probeExit = yield* Effect.gen(function* () {
    const runtime = yield* makeDevinCloudAcpRuntime({
      settings,
      environment,
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    return yield* runtime.initialize();
  }).pipe(Effect.scoped, Effect.timeoutOption(ACP_PROBE_TIMEOUT_MS), Effect.exit);
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
      message: `Devin Cloud ACP probe timed out after ${ACP_PROBE_TIMEOUT_MS}ms.`,
    });
  }
  return snapshot({
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
  });
});
