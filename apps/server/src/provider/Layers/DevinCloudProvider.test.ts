import { describe, expect, it } from "@effect/vitest";
import { DevinCloudSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
} from "./DevinCloudProvider.ts";

const decodeSettings = Schema.decodeSync(DevinCloudSettings);

const emptyFileSystem = FileSystem.layerNoop({
  readFileString: (path) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "readFileString",
        description: "no such file",
        pathOrDescriptor: path,
      }),
    ),
});

describe("buildInitialDevinCloudProviderSnapshot", () => {
  it.effect("reports a disabled provider without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(
        decodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("seeds the built-in cloud model list", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(decodeSettings({}));
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("devin-2-5");
      expect(slugs).toContain("devin-ultra");
      expect(snapshot.models.find((model) => model.slug === "devin-2-5")?.isDefault).toBe(true);
    }),
  );
});

describe("checkDevinCloudProviderStatus", () => {
  it.effect("reports unauthenticated with login guidance when credentials are missing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinCloudProviderStatus(decodeSettings({}), {
        HOME: "/nonexistent-home",
      });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("devin auth login");
    }).pipe(Effect.provide(emptyFileSystem)),
  );

  it.effect("reports disabled without touching the filesystem", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinCloudProviderStatus(decodeSettings({ enabled: false }), {});
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.message).toContain("disabled");
    }).pipe(Effect.provide(FileSystem.layerNoop({}))),
  );
});
