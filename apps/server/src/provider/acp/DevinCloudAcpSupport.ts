import { type DevinCloudSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeDevinCloudReconnect } from "./DevinCloudReconnect.ts";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

export type DevinCloudCredentialsIssue =
  | "missing-file"
  | "missing-token"
  | "not-devin-token"
  | "missing-api-url";

export class DevinCloudCredentialsError extends Data.TaggedError("DevinCloudCredentialsError")<{
  readonly issue: DevinCloudCredentialsIssue;
  readonly path: string;
}> {
  override get message() {
    switch (this.issue) {
      case "missing-file":
        return `Devin credentials file not found at ${this.path}. Run \`devin auth login\`.`;
      case "missing-token":
        return `Devin credentials at ${this.path} contain no API token. Run \`devin auth login\`.`;
      case "not-devin-token":
        return `Devin Cloud requires a Devin account token. Run \`devin auth login\` and sign in with Devin.`;
      case "missing-api-url":
        return `Devin credentials at ${this.path} are missing the API URL. Re-run \`devin auth login\`.`;
    }
  }
}

export interface DevinCloudCredentials {
  readonly token: string;
  readonly apiUrl: string;
}

/** Default location the Devin CLI writes credentials to (`devin auth login`). */
export function defaultDevinCredentialsPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const home = env.HOME || env.USERPROFILE || "";
  if (env.XDG_DATA_HOME) {
    return `${env.XDG_DATA_HOME}/devin/credentials.toml`;
  }
  if (platform === "win32") {
    const appData = env.APPDATA || `${home}/AppData/Roaming`;
    return `${appData}/devin/credentials.toml`;
  }
  return `${home}/.local/share/devin/credentials.toml`;
}

function parseCredentialsField(toml: string, name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m").exec(toml);
  return match?.[1] || undefined;
}

/**
 * Reads the Devin CLI credentials file and extracts the Devin account token
 * (shared across Devin products, so a stable-channel `devin auth login` is
 * enough) plus the cloud API base URL.
 */
export const loadDevinCloudCredentials = Effect.fn("loadDevinCloudCredentials")(function* (
  cloudSettings: Pick<DevinCloudSettings, "credentialsPath"> | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<DevinCloudCredentials, DevinCloudCredentialsError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const path = cloudSettings?.credentialsPath || defaultDevinCredentialsPath(environment, platform);
  const toml = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => new DevinCloudCredentialsError({ issue: "missing-file", path })));
  const rawToken =
    parseCredentialsField(toml, "api_key") ?? parseCredentialsField(toml, "windsurf_api_key");
  if (!rawToken) {
    return yield* new DevinCloudCredentialsError({ issue: "missing-token", path });
  }
  if (!rawToken.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) {
    return yield* new DevinCloudCredentialsError({ issue: "not-devin-token", path });
  }
  const apiUrl = parseCredentialsField(toml, "devin_api_url");
  if (!apiUrl) {
    return yield* new DevinCloudCredentialsError({ issue: "missing-api-url", path });
  }
  return { token: rawToken.slice(DEVIN_SESSION_TOKEN_PREFIX.length), apiUrl };
});

/** ACP live-relay WebSocket endpoint for a Devin Cloud API base URL. */
export function buildDevinCloudAcpWebSocketUrl(credentials: DevinCloudCredentials): string {
  const url = new URL(credentials.apiUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = "/acp/live";
  url.search = `?token=${encodeURIComponent(credentials.token)}`;
  return url.toString();
}

interface DevinCloudAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "webSocket"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly credentials: DevinCloudCredentials;
}

/**
 * Devin Cloud relays ACP over a WebSocket authenticated by the CLI's stored
 * account token, so like the local adapter the runtime never calls
 * `authenticate` (`authMethodId: null`); missing or non-Devin credentials
 * surface through the provider health probe instead.
 */
export const makeDevinCloudAcpRuntime = (
  input: DevinCloudAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  makeDevinCloudReconnect(input, (connectionOptions) =>
    Effect.gen(function* () {
      const acpContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...input,
          ...connectionOptions,
          webSocket: { url: buildDevinCloudAcpWebSocketUrl(input.credentials) },
          authMethodId: null,
          sessionLoadReplayIdleGap: null,
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(acpContext),
      );
    }),
  );
