import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DevinCloudSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import { checkDevinCloudCliProviderStatus } from "./DevinCloudCliProvider.ts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
  makeDevinCloudModelDiscovery,
} from "./DevinCloudProvider.ts";

const decodeSettings = Schema.decodeSync(DevinCloudSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.Number, Schema.String]),
      method: Schema.String,
    }),
  ),
);

const makeCli = (
  options: {
    refuse?: number;
    authenticated?: boolean;
    missing?: boolean;
    versionCode?: number;
  } = {},
) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; env: unknown }> = [];
  const requests: string[] = [];
  let connections = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      calls.push({ command: command.command, args: command.args, env: command.options.env });
      if (options.missing)
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "missing CLI",
        });
      const acp = command.args[0] === "acp";
      const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const terminate = (code = 0) => {
        Deferred.doneUnsafe(exited, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
        Queue.endUnsafe(output);
      };
      yield* Effect.addFinalizer(() => Effect.sync(terminate));
      if (!acp) {
        const version = command.args[0] === "--version";
        Queue.offerUnsafe(
          output,
          new TextEncoder().encode(
            version
              ? "devin 3000.11.1 (test)\n"
              : options.authenticated === false
                ? "Not logged in.\n"
                : "Logged in as test@example.com\n",
          ),
        );
        terminate(version ? (options.versionCode ?? 0) : 0);
      }
      const refuse = acp && connections++ < (options.refuse ?? 0);
      let buffer = "";
      const decoder = new TextDecoder();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(exited),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => Effect.sync(terminate),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            buffer += decoder.decode(chunk, { stream: true });
            let newline = buffer.indexOf("\n");
            while (newline !== -1) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line.trim()) {
                const request = decodeRequest(line);
                requests.push(request.method);
                expect(request.method).toBe("initialize");
                if (refuse) terminate(1);
                else
                  Queue.offerUnsafe(
                    output,
                    new TextEncoder().encode(
                      `${encodeJson({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                          protocolVersion: 1,
                          agentCapabilities: {},
                          authMethods: [],
                          agentInfo: { name: "devin", version: "cloud-server-version" },
                        },
                      })}\n`,
                    ),
                  );
              }
              newline = buffer.indexOf("\n");
            }
          }),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, calls, requests, connections: () => connections };
};

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
      yield* discovery.onSessionSetup({
        configOptions: [
          {
            id: "org_id",
            name: "Organization",
            type: "select",
            currentValue: "org-work",
            options: [
              {
                group: "account",
                name: "Account",
                options: [
                  { value: "org-work", name: "Work" },
                  { value: "org-personal", name: "Personal" },
                ],
              },
            ],
          },
        ],
      });
      const organizations = [
        { id: "org-work", name: "Work" },
        { id: "org-personal", name: "Personal" },
      ];
      expect(yield* provider.refresh).toHaveProperty("organizations", organizations);
      yield* discovery.onSessionSetup({ configOptions: [] });
      expect(yield* provider.getSnapshot).toHaveProperty("organizations", organizations);
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

describe.each([
  { name: "devinCloud", checkProvider: checkDevinCloudProviderStatus },
  { name: "devinCloudCli", checkProvider: checkDevinCloudCliProviderStatus },
])("Cloud CLI health ($name)", ({ checkProvider }) => {
  it.effect("reports unauthenticated with login guidance without opening cloud ACP", () =>
    Effect.gen(function* () {
      const cli = makeCli({ authenticated: false });
      const snapshot = yield* checkProvider(decodeSettings({}), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("auth login");
      expect(cli.connections()).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports disabled without launching the CLI", () =>
    Effect.gen(function* () {
      const cli = makeCli();
      const snapshot = yield* checkProvider(decodeSettings({ enabled: false }), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(snapshot.status).toBe("disabled");
      expect(cli.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires explicit migration of custom credentials before probing", () =>
    Effect.gen(function* () {
      const cli = makeCli();
      const snapshot = yield* checkProvider(
        decodeSettings({ credentialsPath: "/legacy.toml" }),
        {},
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner));
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("clear the legacy");
      expect(cli.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing CLI", () =>
    Effect.gen(function* () {
      const cli = makeCli({ missing: true });
      const snapshot = yield* checkProvider(decodeSettings({}), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Binary path");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not launch ACP after a failing version command", () =>
    Effect.gen(function* () {
      const cli = makeCli({ versionCode: 1 });
      const snapshot = yield* checkProvider(decodeSettings({}), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(snapshot.status).toBe("error");
      expect(cli.calls).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "uses the selected CLI and environment and only initializes, never creates a session",
    () =>
      Effect.gen(function* () {
        const cli = makeCli({ refuse: 1 });
        const snapshot = yield* checkProvider(decodeSettings({ binaryPath: "/bin/devin-stable" }), {
          XDG_DATA_HOME: "/isolated",
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner));
        expect(cli.connections()).toBe(2);
        expect(cli.requests).toEqual(["initialize", "initialize"]);
        expect(cli.calls.map((call) => call.args)).toEqual([
          ["--version"],
          ["auth", "status"],
          ["acp", "--cloud"],
          ["acp", "--cloud"],
        ]);
        for (const call of cli.calls) {
          expect(call.command).toBe("/bin/devin-stable");
          expect(call.env).toMatchObject({ XDG_DATA_HOME: "/isolated" });
        }
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.version).toBe("3000.11.1");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports cloud ACP failure after retries, with upgrade and login guidance", () =>
    Effect.gen(function* () {
      const cli = makeCli({ refuse: Number.POSITIVE_INFINITY });
      const snapshot = yield* checkProvider(decodeSettings({}), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
      );
      expect(cli.connections()).toBe(3);
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.message).toContain("acp --cloud");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
