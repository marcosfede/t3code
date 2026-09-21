import { type DevinCloudSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { buildDevinAcpSpawnInput } from "./DevinAcpSupport.ts";
import { makeDevinCloudReconnect } from "./DevinCloudReconnect.ts";

export const DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE =
  "Devin Cloud now uses the Devin CLI for authentication. Sign in with the configured binary using `auth login`, then clear the legacy Credentials path in Settings → Providers. For an isolated account, configure the CLI's XDG_DATA_HOME in the provider environment.";

type DevinCloudRuntimeSettings = Pick<DevinCloudSettings, "binaryPath" | "credentialsPath">;

export function buildDevinCloudAcpSpawnInput(
  cloudSettings: DevinCloudRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return { ...buildDevinAcpSpawnInput(cloudSettings, cwd, environment), args: ["acp", "--cloud"] };
}

export const withDevinCloudOrganization = Effect.fn("withDevinCloudOrganization")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  configuredOrganizationId: string | undefined,
) {
  const organizationId = configuredOrganizationId?.trim();
  if (!organizationId) return runtime;
  const start = yield* Effect.cached(
    Effect.gen(function* () {
      const started = yield* runtime.start();
      const selected = yield* runtime.setConfigOption("org_id", organizationId);
      return {
        ...started,
        sessionSetupResult: {
          ...started.sessionSetupResult,
          configOptions: selected.configOptions,
          _meta: { ...started.sessionSetupResult._meta, ...selected._meta },
        },
      };
    }),
  );
  return {
    ...runtime,
    start: () => start,
    prompt: (payload, options) => start.pipe(Effect.andThen(runtime.prompt(payload, options))),
  } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
});

interface DevinCloudAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cloudSettings: DevinCloudRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly organizationId?: string;
}

export const makeDevinCloudAcpRuntime = (
  input: DevinCloudAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    if (input.cloudSettings?.credentialsPath?.trim()) {
      return yield* new EffectAcpErrors.AcpSpawnError({
        cause: new Error(DEVIN_CLOUD_CREDENTIALS_MIGRATION_MESSAGE),
      });
    }
    return yield* makeDevinCloudReconnect(input, (connectionOptions) =>
      Effect.gen(function* () {
        const acpContext = yield* Layer.build(
          AcpSessionRuntime.layer({
            ...input,
            ...connectionOptions,
            spawn: buildDevinCloudAcpSpawnInput(input.cloudSettings, input.cwd, input.environment),
            authMethodId: null,
            sessionLoadReplayIdleGap: null,
          }).pipe(
            Layer.provide(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
            ),
          ),
        );
        const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
          Effect.provide(acpContext),
        );
        return yield* withDevinCloudOrganization(
          runtime,
          connectionOptions.resumeSessionId ? undefined : input.organizationId,
        );
      }),
    );
  });
