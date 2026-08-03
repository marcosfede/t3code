import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildDevinDiscoveredModelsFromSessionSetup,
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  parseDevinAuthStatus,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

describe("parseDevinAuthStatus", () => {
  it("detects the unauthenticated CLI", () => {
    expect(parseDevinAuthStatus("Not logged in.\nRun `devin auth login` to authenticate.")).toEqual(
      { status: "unauthenticated" },
    );
  });

  it("detects an authenticated CLI", () => {
    expect(parseDevinAuthStatus("Logged in as dev@example.com")).toEqual({
      status: "authenticated",
    });
  });

  it("falls back to unknown for unrecognized output", () => {
    expect(parseDevinAuthStatus("something unexpected")).toEqual({ status: "unknown" });
  });
});

describe("buildDevinDiscoveredModelsFromSessionSetup", () => {
  it("builds models from the negotiated model config option", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "swe-1-6-fast",
          options: [
            { name: "SWE-1.6 Fast", value: "swe-1-6-fast" },
            { name: "SWE-1.6", value: "swe-1-6" },
            { name: "", value: "swe-1-6-fast" },
          ],
        },
      ],
    } as unknown as EffectAcpSchema.NewSessionResponse;

    const models = buildDevinDiscoveredModelsFromSessionSetup(setup);
    expect(models.map((model) => model.slug)).toEqual(["swe-1-6-fast", "swe-1-6"]);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[1]?.isDefault).toBeUndefined();
  });

  it("returns no models when the setup exposes no model option", () => {
    const setup = {
      sessionId: "sess-1",
      configOptions: [],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(buildDevinDiscoveredModelsFromSessionSetup(setup)).toEqual([]);
  });
});

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Devin");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["swe-1-6-fast"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken devin install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-version-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Devin CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("surfaces an unauthenticated CLI without attempting ACP startup", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-unauth-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "devin 3000.3.27\\n"; exit 0; fi',
              'if [ "$1" = "auth" ]; then printf "Not logged in.\\n"; exit 0; fi',
              "exit 1",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth).toEqual({ status: "unauthenticated" });
      expect(snapshot.message).toContain("devin auth login");
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-success-" });
          const devinPath = path.join(dir, "devin");
          yield* fs.writeFileString(
            devinPath,
            [
              "#!/bin/sh",
              'if [ "$1" = "--version" ]; then printf "devin 3000.3.27\\n"; exit 0; fi',
              'if [ "$1" = "auth" ]; then printf "Logged in as dev@example.com\\n"; exit 0; fi',
              "exit 1",
              "",
            ].join("\n"),
          );
          yield* fs.chmod(devinPath, 0o755);

          return yield* checkDevinProviderStatus(
            decodeDevinSettings({ enabled: true, binaryPath: devinPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth).toEqual({ status: "authenticated" });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["swe-1-6-fast"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
