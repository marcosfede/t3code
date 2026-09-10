import { describe, expect, it } from "@effect/vitest";
import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DevinCloudSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { WebSocketServer } from "ws";
import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
  makeDevinCloudModelDiscovery,
} from "./DevinCloudProvider.ts";

const decodeSettings = Schema.decodeSync(DevinCloudSettings);

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

const emptyFileSystem = fileSystemWith({});

/** ACP relay stand-in that drops the first `refuse` handshakes, then answers `initialize`. */
const makeRelay = (refuse: number) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resume(Effect.void));
        }),
    );
    let connections = 0;
    const methods: string[] = [];
    server.on("connection", (socket) => {
      if (connections++ < refuse) {
        socket.terminate();
        return;
      }
      socket.on("message", (data) => {
        const request = JSON.parse(String(data)) as { id?: number; method?: string };
        if (request.method) methods.push(request.method);
        if (request.method !== "initialize") return;
        socket.send(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
              agentInfo: { name: "devin", version: "relay-test" },
            },
          })}\n`,
        );
      });
    });
    yield* Effect.callback<void>((resume) => {
      server.once("listening", () => resume(Effect.void));
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("No relay address");
    return {
      credentialsToml: `api_key = "devin-session-token$test"\ndevin_api_url = "http://127.0.0.1:${address.port}"\n`,
      connections: () => connections,
      methods,
    };
  });

describe("buildInitialDevinCloudProviderSnapshot", () => {
  it.effect("shows standard Cloud modes before a session exists", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(decodeSettings({}));
      expect(snapshot.models.map((model) => [model.slug, model.name])).toEqual([
        ["devin-2-5", "Normal"],
        ["devin-fast-opus", "Fast"],
        ["devin-ultra", "Ultra"],
        ["devin_lite", "Lite"],
        ["devin-auto", "Fusion"],
      ]);
      expect(snapshot.models.find((model) => model.isDefault)?.slug).toBe("devin-2-5");
      expect(snapshot.models[0]?.aliases).toContain(DEVIN_CLOUD_DEFAULT_MODEL);
      for (const driver of ["devinCloud", "devinCloudCli"]) {
        const kind = ProviderDriverKind.make(driver);
        expect(DEFAULT_MODEL_BY_PROVIDER[kind]).toBe("devin-2-5");
        expect(normalizeModelSlug(DEVIN_CLOUD_DEFAULT_MODEL, kind)).toBe("devin-2-5");
      }
    }),
  );

  it.effect("preserves custom model names and capabilities from structured settings", () =>
    Effect.gen(function* () {
      const capabilities = { optionDescriptors: [] };
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(
        decodeSettings({
          customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
        }),
      );
      expect(snapshot.models.filter((model) => model.isCustom)).toEqual([
        expect.objectContaining({ slug: "bare-slug", name: "bare-slug" }),
        expect.objectContaining({ slug: "named", name: "Named", capabilities }),
      ]);
    }),
  );

  it.effect("reports a disabled provider without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinCloudProviderSnapshot(
        decodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});

describe("makeDevinCloudModelDiscovery", () => {
  it.effect("publishes session-advertised models and retains them across health refreshes", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ customModels: ["custom-model"] });
      const initial: ServerProvider = {
        ...(yield* buildInitialDevinCloudProviderSnapshot(settings)),
        instanceId: ProviderInstanceId.make("devinCloud"),
        driver: ProviderDriverKind.make("devinCloud"),
      };
      const source = {
        getSnapshot: Effect.succeed(initial),
        refresh: Effect.succeed(initial),
        streamChanges: Stream.never,
        resolveMaintenance: () => Effect.die("not used"),
        applyUsageLimits: () => Effect.void,
      } satisfies ServerProviderShape;
      const discovery = yield* makeDevinCloudModelDiscovery(settings.customModels);
      const provider = discovery.decorate(source);
      expect((yield* provider.getSnapshot).models).toEqual(initial.models);
      yield* discovery.onSessionSetup({
        configOptions: [
          {
            id: "devin_version",
            name: "Model",
            type: "select",
            currentValue: "session-model",
            options: [{ value: "session-model", name: "Session model" }],
          },
        ],
      });
      for (const snapshot of [yield* provider.getSnapshot, yield* provider.refresh]) {
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "session-model",
          "custom-model",
        ]);
        expect(snapshot.models[0]).toMatchObject({ name: "Session model", isDefault: true });
        expect(snapshot.models[0]?.isLegacy).not.toBe(true);
      }
      const emitted = yield* Stream.runHead(provider.streamChanges);
      expect(Option.getOrThrow(emitted).models[0]?.slug).toBe("session-model");
      yield* discovery.onSessionSetup({ configOptions: [] });
      expect((yield* provider.getSnapshot).models[0]?.slug).toBe("session-model");
      yield* discovery.onSessionSetup({
        configOptions: [
          { id: "devin_version", name: "Model", type: "select", currentValue: "", options: [] },
        ],
      });
      expect((yield* provider.getSnapshot).models).toEqual(initial.models);
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

  it.live("stays ready when the relay drops a handshake that a retry completes", () =>
    Effect.gen(function* () {
      const relay = yield* makeRelay(1);
      const snapshot = yield* checkDevinCloudProviderStatus(
        decodeSettings({ credentialsPath: "/relay/credentials.toml" }),
        {},
      ).pipe(Effect.provide(fileSystemWith({ "/relay/credentials.toml": relay.credentialsToml })));
      expect(relay.connections()).toBe(2);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.version).toBe("relay-test");
      expect(relay.methods).toContain("initialize");
      expect(relay.methods.filter((method) => method.startsWith("session/"))).toEqual([]);
      expect(snapshot.models.map((model) => model.name)).toEqual([
        "Normal",
        "Fast",
        "Ultra",
        "Lite",
        "Fusion",
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("reports an outage once retries are exhausted", () =>
    Effect.gen(function* () {
      const relay = yield* makeRelay(Number.POSITIVE_INFINITY);
      const snapshot = yield* checkDevinCloudProviderStatus(
        decodeSettings({ credentialsPath: "/relay/credentials.toml" }),
        {},
      ).pipe(Effect.provide(fileSystemWith({ "/relay/credentials.toml": relay.credentialsToml })));
      expect(relay.connections()).toBe(3);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Could not reach");
    }).pipe(Effect.scoped),
  );
});
