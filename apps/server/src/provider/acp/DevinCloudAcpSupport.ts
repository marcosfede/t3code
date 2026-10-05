import type { DevinCloudSettings, ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpCompat from "effect-acp/compat";
import * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export const DEVIN_CLOUD_ORGANIZATION_OPTION_ID = "org_id";
export const DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE =
  "Devin Cloud now uses the Devin CLI for authentication. Sign in with the configured binary using `auth login`, then clear the legacy Credentials path in Settings → Providers. For an isolated account, configure the CLI's XDG_DATA_HOME in the provider environment.";
const DEVIN_CLOUD_MODEL_OPTION_IDS = new Set(["model", "devin_version"]);

type SessionConfigOption = AcpCompat.SessionConfigOption;
type SelectConfigOption = Extract<SessionConfigOption, { readonly type: "select" }>;

export function buildDevinCloudAcpSpawnInput(
  settings: Pick<DevinCloudSettings, "binaryPath">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "devin",
    args: ["acp", "--cloud"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/** A thread-level selection wins over the provider's configured default. */
export function resolveDevinCloudOrganizationId(
  providerOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  settingsOrganizationId: string | undefined,
): string | undefined {
  return (
    getProviderOptionStringSelectionValue(
      providerOptions,
      DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
    )?.trim() || settingsOrganizationId
  );
}

export function selectConfigOptionChoices(option: SelectConfigOption) {
  return option.options.flatMap((entry) => ("groupId" in entry ? entry.options : [entry]));
}

export function findDevinCloudModelOption(
  configOptions: ReadonlyArray<SessionConfigOption>,
): SelectConfigOption | undefined {
  const option =
    configOptions.find((candidate) => candidate.category === "model") ??
    configOptions.find((candidate) => DEVIN_CLOUD_MODEL_OPTION_IDS.has(candidate.id));
  return option?.type === "select" ? option : undefined;
}

export interface DevinCloudConfigCatalog {
  readonly models?: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly currentModel?: string;
  readonly organizations?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly defaultOrganizationId?: string;
}

/** Reads the model and organization pickers a Cloud session advertises. */
export function devinCloudCatalogFromConfigOptions(
  configOptions: ReadonlyArray<SessionConfigOption>,
): DevinCloudConfigCatalog {
  const modelOption = findDevinCloudModelOption(configOptions);
  const organizationOption = configOptions.find(
    (option) => option.id === DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
  );
  const choices = (option: SelectConfigOption) =>
    selectConfigOptionChoices(option).flatMap((choice) => {
      const value = choice.value.trim();
      return value ? [{ value, name: choice.name.trim() || value }] : [];
    });
  return {
    ...(modelOption
      ? {
          models: choices(modelOption).map(({ value, name }) => ({ slug: value, name })),
          ...(modelOption.currentValue.trim()
            ? { currentModel: modelOption.currentValue.trim() }
            : {}),
        }
      : {}),
    ...(organizationOption?.type === "select"
      ? {
          organizations: choices(organizationOption).map(({ value, name }) => ({
            id: value,
            name,
          })),
          ...(organizationOption.currentValue.trim()
            ? { defaultOrganizationId: organizationOption.currentValue.trim() }
            : {}),
        }
      : {}),
  };
}

/**
 * The organization of a Cloud session is fixed once it exists: it can only be
 * chosen on a session this runtime created, before its first prompt. Resumed,
 * loaded, or prompted sessions keep their organization.
 */
export const withDevinCloudOrganizationLock = Effect.fn("withDevinCloudOrganizationLock")(
  function* (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    input: { readonly resumeSessionId?: string; readonly organizationId?: string },
  ) {
    const organizationMutable = yield* Ref.make(false);
    const lock = Ref.set(organizationMutable, false);
    const setConfigOption: AcpSessionRuntime.AcpSessionRuntime["Service"]["setConfigOption"] = (
      configId,
      value,
    ) =>
      configId !== DEVIN_CLOUD_ORGANIZATION_OPTION_ID
        ? runtime.setConfigOption(configId, value)
        : Effect.flatMap(Ref.get(organizationMutable), (mutable) =>
            mutable
              ? runtime.setConfigOption(configId, value)
              : Effect.map(runtime.getConfigOptions, (configOptions) => ({
                  configOptions: [...configOptions],
                })),
          );
    return {
      ...runtime,
      start: () =>
        runtime.start().pipe(
          Effect.tap(() => Ref.set(organizationMutable, input.resumeSessionId === undefined)),
          Effect.tap(() =>
            input.resumeSessionId === undefined && input.organizationId
              ? selectOrganization(runtime, input.organizationId)
              : Effect.void,
          ),
        ),
      loadSession: (sessionId, options) =>
        Effect.andThen(lock, runtime.loadSession(sessionId, options)),
      resumeSession: (sessionId, options) =>
        Effect.andThen(lock, runtime.resumeSession(sessionId, options)),
      prompt: (
        payload: Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"]>[0],
        promptOptions?: Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["prompt"]>[1],
      ) => Effect.andThen(lock, runtime.prompt(payload, promptOptions)),
      setConfigOption,
    } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
  },
);

const selectOrganization = (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  organizationId: string,
) =>
  Effect.gen(function* () {
    const option = (yield* runtime.getConfigOptions).find(
      (candidate) => candidate.id === DEVIN_CLOUD_ORGANIZATION_OPTION_ID,
    );
    if (option?.type !== "select" || option.currentValue === organizationId) return;
    if (!selectConfigOptionChoices(option).some((choice) => choice.value === organizationId)) {
      yield* Effect.logWarning("Devin Cloud organization is not available to this account", {
        organizationId,
      });
      return;
    }
    yield* runtime.setConfigOption(DEVIN_CLOUD_ORGANIZATION_OPTION_ID, organizationId);
  });

export interface DevinCloudRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn"
> {
  readonly settings: Pick<DevinCloudSettings, "binaryPath" | "credentialsPath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export const makeDevinCloudAcpRuntime = (
  input: DevinCloudRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { settings, environment, childProcessSpawner, ...runtimeOptions } = input;
    if (settings.credentialsPath?.trim()) {
      return yield* new EffectAcpErrors.AcpSpawnError({
        cause: new Error(DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE),
      });
    }
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildDevinCloudAcpSpawnInput(settings, input.cwd, environment),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

export interface DevinNativeSession {
  readonly sessionId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly updatedAt: string | null;
  readonly url: string | null;
  readonly status: string | null;
  readonly repositories: ReadonlyArray<string>;
  readonly excerpt: string | null;
}

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function metaRepositories(meta: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const value = meta["cognition.ai/sessionRepos"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) return [];
    return typeof entry.name === "string" && entry.name ? [entry.name] : [];
  });
}

/** Maps an ACP `session/list` entry, reading Devin's `cognition.ai/*` metadata. */
export function devinNativeSessionFromAcp(
  info: EffectAcpSchema.SessionInfo,
): DevinNativeSession | undefined {
  const meta = info._meta ?? {};
  if (meta["cognition.ai/isArchived"] === true) return undefined;
  const sessionId = info.sessionId.trim();
  if (!sessionId) return undefined;
  return {
    sessionId,
    title: info.title?.trim() || null,
    cwd: info.cwd.trim() || null,
    updatedAt: info.updatedAt ?? null,
    url: metaString(meta, "cognition.ai/url"),
    status: metaString(meta, "cognition.ai/statusEnum"),
    repositories: metaRepositories(meta),
    excerpt: metaString(meta, "cognition.ai/messageExcerpts"),
  };
}

const decodeListSessionsResponse = Schema.decodeUnknownEffect(EffectAcpSchema.ListSessionsResponse);

export interface DevinSessionPageInput {
  readonly cursor?: string;
  readonly query?: string;
  readonly updatedAfter?: string;
  readonly sessionId?: string;
}

/** One account-wide page. Organization selection only applies to new sessions. */
export const listDevinCloudSessions = Effect.fn("listDevinCloudSessions")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "initialize" | "request">,
  input: DevinSessionPageInput = {},
) {
  yield* runtime.initialize();
  const response = yield* runtime
    .request("session/list", {
      ...(input.cursor ? { cursor: input.cursor } : {}),
      _meta: {
        "cognition.ai/limit": 50,
        ...(input.query ? { "cognition.ai/content": input.query } : {}),
        ...(input.updatedAfter ? { "cognition.ai/updatedAfter": input.updatedAfter } : {}),
        ...(input.sessionId
          ? { "cognition.ai/sessionIds": [input.sessionId], "cognition.ai/skipDiscovery": true }
          : {}),
      },
    })
    .pipe(Effect.flatMap(decodeListSessionsResponse));
  return {
    sessions: response.sessions.flatMap((info) => {
      const session = devinNativeSessionFromAcp(info);
      return session ? [session] : [];
    }),
    nextCursor: response.nextCursor?.trim() || null,
  };
});

/**
 * Reads the model and organization pickers without starting a conversation.
 * `session/new` on `devin acp --cloud` is a draft that is never listed.
 */
export const discoverDevinCloudConfigOptions = Effect.fn("discoverDevinCloudConfigOptions")(
  function* (runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "start">) {
    const started = yield* runtime.start();
    return started.sessionSetupResult.configOptions ?? [];
  },
);
