import {
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Arr from "effect/Array";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { findDevinModelConfigOption, makeDevinAcpRuntime } from "../acp/DevinAcpSupport.ts";
import {
  buildDevinConfigOptionDescriptors,
  buildDevinFamilyOptionDescriptors,
  buildDevinModelFamilies,
  devinFamilyProbeModelId,
  mergeDevinOptionDescriptors,
} from "../acp/DevinModelCatalog.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const AUTH_PROBE_TIMEOUT_MS = 4_000;
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_MODEL_OPTIONS_PROBE_TIMEOUT_MS = 30_000;
const DEVIN_MODEL_OPTIONS_PROBE_PROCESSES = 6;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "swe-1-6-fast",
    name: "SWE-1.6 Fast",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: DevinSettings["customModels"] | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function flattenSessionConfigSelectOptions(
  options:
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption>
    | ReadonlyArray<EffectAcpSchema.SessionConfigSelectGroup>,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

type DevinSessionSetupResult =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

/** Config options each model reports once it is the session's active model. */
export type DevinConfigOptionsByModel = ReadonlyMap<
  string,
  ReadonlyArray<EffectAcpSchema.SessionConfigOption>
>;

function devinModelCatalogFromSessionSetup(sessionSetupResult: DevinSessionSetupResult) {
  const modelOption = findDevinModelConfigOption(sessionSetupResult);
  if (!modelOption || modelOption.type !== "select") {
    return undefined;
  }
  return {
    families: buildDevinModelFamilies(flattenSessionConfigSelectOptions(modelOption.options)),
    currentValue:
      typeof modelOption.currentValue === "string" ? modelOption.currentValue.trim() : undefined,
  };
}

/** Model ids whose options must be probed: one per family, minus the active model, whose
 * options the session setup already reports. */
export function devinModelIdsToProbe(
  sessionSetupResult: DevinSessionSetupResult,
): ReadonlyArray<string> {
  const catalog = devinModelCatalogFromSessionSetup(sessionSetupResult);
  return (catalog?.families ?? [])
    .map((family) => devinFamilyProbeModelId(family, catalog?.currentValue))
    .filter((modelId) => modelId !== catalog?.currentValue);
}

export function buildDevinDiscoveredModelsFromSessionSetup(
  sessionSetupResult: DevinSessionSetupResult,
  probedConfigOptions: DevinConfigOptionsByModel = new Map(),
): ReadonlyArray<ServerProviderModel> {
  const catalog = devinModelCatalogFromSessionSetup(sessionSetupResult);
  if (!catalog) {
    return [];
  }
  const { families, currentValue } = catalog;

  return families.map((family): ServerProviderModel => {
    const isFlat = family.variants.length === 1;
    const isDefault =
      currentValue !== undefined &&
      family.variants.some((variant) => variant.slug === currentValue);
    const probeModelId = devinFamilyProbeModelId(family, currentValue);

    const descriptors = mergeDevinOptionDescriptors(
      isFlat
        ? []
        : buildDevinFamilyOptionDescriptors({
            family,
            sessionCurrentValue: currentValue,
          }),
      buildDevinConfigOptionDescriptors(
        (probeModelId === currentValue
          ? sessionSetupResult.configOptions
          : probedConfigOptions.get(probeModelId)) ?? [],
      ),
    );

    const capabilities =
      descriptors.length > 0
        ? createModelCapabilities({ optionDescriptors: descriptors })
        : EMPTY_CAPABILITIES;

    return {
      slug: family.slug,
      name: family.name,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
      capabilities,
      ...(!isFlat ? { aliases: family.variants.map((variant) => variant.slug) } : {}),
    };
  });
}

const startDevinDiscoveryRuntime = (devinSettings: DevinSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return { acp, sessionSetupResult: started.sessionSetupResult };
  });

const discoverDevinModelsViaAcp = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  startDevinDiscoveryRuntime(devinSettings, environment).pipe(
    Effect.map(({ sessionSetupResult }) => sessionSetupResult),
    Effect.scoped,
  );

/**
 * Devin reports reasoning and speed options only for the session's active model, so each
 * model's options come from switching a throwaway session to it. A switch takes ~200ms, so
 * the ids are split across a few `devin acp` processes; models that fail to switch are skipped.
 */
const probeDevinModelConfigOptions = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  modelIds: ReadonlyArray<string>,
) =>
  Effect.forEach(
    Arr.split(modelIds, DEVIN_MODEL_OPTIONS_PROBE_PROCESSES),
    (chunk) =>
      Effect.gen(function* () {
        const { acp } = yield* startDevinDiscoveryRuntime(devinSettings, environment);
        return yield* Effect.forEach(chunk, (modelId) =>
          acp.setModel(modelId).pipe(
            Effect.andThen(acp.getConfigOptions),
            Effect.map((configOptions) => [modelId, configOptions] as const),
            Effect.option,
          ),
        );
      }).pipe(Effect.scoped),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      (chunks): DevinConfigOptionsByModel => new Map(chunks.flat().flatMap(Option.toArray)),
    ),
  );

export type DevinModelConfigOptionsProbe = (input: {
  readonly version: string | null;
  readonly modelIds: ReadonlyArray<string>;
}) => Effect.Effect<DevinConfigOptionsByModel, EffectAcpErrors.AcpError>;

/** Per-instance probe cache: options only change with the CLI version or the model list. */
export const makeDevinModelConfigOptionsProbe = Effect.fn("makeDevinModelConfigOptionsProbe")(
  function* (devinSettings: DevinSettings, environment: NodeJS.ProcessEnv = process.env) {
    const cache = yield* Cache.makeWith(
      (key: string) =>
        probeDevinModelConfigOptions(
          devinSettings,
          environment,
          (JSON.parse(key) as [string | null, ReadonlyArray<string>])[1],
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.size > 0 ? Duration.minutes(30) : Duration.zero,
      },
    );
    const probe: DevinModelConfigOptionsProbe = ({ version, modelIds }) =>
      Cache.get(cache, JSON.stringify([version, modelIds]));
    return probe;
  },
);

export const runDevinCliCommand = (
  devinSettings: Pick<DevinSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Parses `devin auth status` output. The CLI prints "Not logged in." when
 * unauthenticated and "Logged in as <account>" / token details otherwise.
 */
export function parseDevinAuthStatus(output: string): ServerProviderAuth {
  const normalized = output.toLowerCase();
  if (normalized.includes("not logged in")) {
    return { status: "unauthenticated" };
  }
  if (normalized.includes("logged in")) {
    return { status: "authenticated" };
  }
  return { status: "unknown" };
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  probeModelConfigOptions?: DevinModelConfigOptionsProbe,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(devinSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const authResult = yield* runDevinCliCommand(devinSettings, ["auth", "status"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const auth: ServerProviderAuth =
    Result.isSuccess(authResult) && Option.isSome(authResult.success)
      ? parseDevinAuthStatus(
          `${authResult.success.value.stdout}\n${authResult.success.value.stderr}`,
        )
      : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth,
        message: "Devin CLI is installed but not logged in. Run `devin auth login`.",
      },
    });
  }

  const discoveryExit = yield* discoverDevinModelsViaAcp(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Devin ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Devin CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: `Devin CLI is installed but ACP startup timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const sessionSetupResult = discoveryExit.value.value;
  const modelIdsToProbe = probeModelConfigOptions ? devinModelIdsToProbe(sessionSetupResult) : [];
  const probedConfigOptions =
    probeModelConfigOptions && modelIdsToProbe.length > 0
      ? yield* probeModelConfigOptions({ version, modelIds: modelIdsToProbe }).pipe(
          Effect.timeoutOption(DEVIN_MODEL_OPTIONS_PROBE_TIMEOUT_MS),
          Effect.map(Option.getOrUndefined),
          Effect.catchCause((cause) =>
            Effect.logWarning("Devin model option probe failed", {
              errorTag: causeErrorTag(cause),
            }).pipe(Effect.as(undefined)),
          ),
        )
      : undefined;
  const discoveredModels = buildDevinDiscoveredModelsFromSessionSetup(
    sessionSetupResult,
    probedConfigOptions,
  );
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichDevinSnapshot = (input: {
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
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
