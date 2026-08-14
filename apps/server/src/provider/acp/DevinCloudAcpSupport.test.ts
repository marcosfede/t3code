import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildDevinCloudAcpWebSocketUrl,
  defaultDevinCredentialsPath,
  DevinCloudCredentialsError,
  loadDevinCloudCredentials,
} from "./DevinCloudAcpSupport.ts";

const CREDENTIALS_TOML = `
schema_version = "1.0"
api_key = "devin-session-token$abc123"
devin_api_url = "https://api.devin.ai"
`;

const fileSystemWith = (files: Record<string, string>) =>
  FileSystem.layerNoop({
    readFileString: (path) =>
      path in files
        ? Effect.succeed(files[path]!)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              description: "no such file",
              pathOrDescriptor: path,
            }),
          ),
  });

describe("defaultDevinCredentialsPath", () => {
  it("prefers XDG_DATA_HOME", () => {
    expect(defaultDevinCredentialsPath({ XDG_DATA_HOME: "/xdg", HOME: "/home/u" }, "linux")).toBe(
      "/xdg/devin/credentials.toml",
    );
  });

  it("falls back to ~/.local/share", () => {
    expect(defaultDevinCredentialsPath({ HOME: "/home/u" }, "linux")).toBe(
      "/home/u/.local/share/devin/credentials.toml",
    );
  });

  it("uses APPDATA on Windows", () => {
    expect(defaultDevinCredentialsPath({ APPDATA: "C:/Users/u/AppData/Roaming" }, "win32")).toBe(
      "C:/Users/u/AppData/Roaming/devin/credentials.toml",
    );
  });
});

describe("loadDevinCloudCredentials", () => {
  it.effect("reads the token and API URL from credentials.toml", () =>
    Effect.gen(function* () {
      const credentials = yield* loadDevinCloudCredentials(
        { credentialsPath: "/creds/credentials.toml" },
        {},
      );
      expect(credentials).toEqual({ token: "abc123", apiUrl: "https://api.devin.ai" });
    }).pipe(Effect.provide(fileSystemWith({ "/creds/credentials.toml": CREDENTIALS_TOML }))),
  );

  it.effect("uses the default path when settings do not override it", () =>
    Effect.gen(function* () {
      const credentials = yield* loadDevinCloudCredentials(null, { HOME: "/home/u" }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(credentials.token).toBe("abc123");
    }).pipe(
      Effect.provide(
        fileSystemWith({ "/home/u/.local/share/devin/credentials.toml": CREDENTIALS_TOML }),
      ),
    ),
  );

  it.effect("fails with missing-file when the credentials file is absent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadDevinCloudCredentials({ credentialsPath: "/missing.toml" }, {}),
      );
      expect(error).toBeInstanceOf(DevinCloudCredentialsError);
      expect(error.issue).toBe("missing-file");
      expect(error.message).toContain("devin auth login");
    }).pipe(Effect.provide(fileSystemWith({}))),
  );

  it.effect("fails with not-devin-token for a non-Devin account token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadDevinCloudCredentials({ credentialsPath: "/c.toml" }, {}),
      );
      expect(error.issue).toBe("not-devin-token");
    }).pipe(
      Effect.provide(
        fileSystemWith({
          "/c.toml": 'api_key = "other-token"\ndevin_api_url = "https://api.devin.ai"\n',
        }),
      ),
    ),
  );

  it.effect("fails with missing-token when no api_key field exists", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadDevinCloudCredentials({ credentialsPath: "/c.toml" }, {}),
      );
      expect(error.issue).toBe("missing-token");
    }).pipe(Effect.provide(fileSystemWith({ "/c.toml": 'devin_api_url = "https://x"\n' }))),
  );

  it.effect("fails with missing-api-url when devin_api_url is absent", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadDevinCloudCredentials({ credentialsPath: "/c.toml" }, {}),
      );
      expect(error.issue).toBe("missing-api-url");
    }).pipe(Effect.provide(fileSystemWith({ "/c.toml": 'api_key = "devin-session-token$abc"\n' }))),
  );
});

describe("buildDevinCloudAcpWebSocketUrl", () => {
  it("converts https API URLs to wss /acp/live with the token query", () => {
    expect(
      buildDevinCloudAcpWebSocketUrl({ token: "abc123", apiUrl: "https://api.devin.ai" }),
    ).toBe("wss://api.devin.ai/acp/live?token=abc123");
  });

  it("converts http API URLs to ws", () => {
    expect(buildDevinCloudAcpWebSocketUrl({ token: "t", apiUrl: "http://localhost:8080" })).toBe(
      "ws://localhost:8080/acp/live?token=t",
    );
  });

  it("URL-encodes token characters", () => {
    expect(buildDevinCloudAcpWebSocketUrl({ token: "a/b+c", apiUrl: "https://api.devin.ai" })).toBe(
      "wss://api.devin.ai/acp/live?token=a%2Fb%2Bc",
    );
  });
});
