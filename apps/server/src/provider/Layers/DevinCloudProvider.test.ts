import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEVIN_CLOUD_DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DevinCloudSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  applyDevinCloudCatalog,
  buildInitialDevinCloudProviderSnapshot,
  checkDevinCloudProviderStatus,
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
  options: { authenticated?: boolean; missing?: boolean; versionCode?: number } = {},
) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; env: unknown }> = [];
  const requests: string[] = [];
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
  return { spawner, calls, requests };
};

const check = (
  cli: ReturnType<typeof makeCli>,
  settings: Parameters<typeof decodeSettings>[0] = {},
  environment: NodeJS.ProcessEnv = {},
) =>
  checkDevinCloudProviderStatus(decodeSettings(settings), environment, "/workspace").pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner),
  );

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
      const kind = ProviderDriverKind.make("devinCloud");
      expect(DEFAULT_MODEL_BY_PROVIDER[kind]).toBe("devin-2-5");
      expect(normalizeModelSlug(DEVIN_CLOUD_DEFAULT_MODEL, kind)).toBe("devin-2-5");
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
});

describe("applyDevinCloudCatalog", () => {
  it.effect("publishes advertised models and a locked Organization selector", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ organizationId: "org-b" });
      const initial = yield* buildInitialDevinCloudProviderSnapshot(settings);
      const snapshot = applyDevinCloudCatalog(
        { ...initial, instanceId: undefined } as never,
        {
          models: [
            { slug: "devin-2-5", name: "Normal" },
            { slug: "devin-new", name: "New" },
          ],
          currentModel: "devin-new",
          organizations: [
            { id: "org-a", name: "Personal" },
            { id: "org-b", name: "Work" },
          ],
          defaultOrganizationId: "org-a",
        },
        settings,
      );
      expect(snapshot.organizations).toEqual([
        { id: "org-a", name: "Personal" },
        { id: "org-b", name: "Work" },
      ]);
      const defaultModel = snapshot.models.find((model) => model.isDefault);
      expect(defaultModel?.slug).toBe("devin-new");
      expect(defaultModel?.aliases).toContain(DEVIN_CLOUD_DEFAULT_MODEL);
      const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
        (candidate) => candidate.id === "org_id",
      );
      expect(descriptor).toMatchObject({ type: "select", lockedAfterSessionStart: true });
      expect(
        descriptor?.type === "select"
          ? descriptor.options.find((option) => option.isDefault)?.id
          : undefined,
      ).toBe("org-b");
    }),
  );
});

describe("checkDevinCloudProviderStatus", () => {
  it.effect("reports unauthenticated with login guidance without opening cloud ACP", () =>
    Effect.gen(function* () {
      const cli = makeCli({ authenticated: false });
      const snapshot = yield* check(cli);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("auth login");
      expect(cli.requests).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports disabled without launching the CLI", () =>
    Effect.gen(function* () {
      const cli = makeCli();
      const snapshot = yield* check(cli, { enabled: false });
      expect(snapshot.enabled).toBe(false);
      expect(cli.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires explicit migration of legacy credentials before probing", () =>
    Effect.gen(function* () {
      const cli = makeCli();
      const snapshot = yield* check(cli, { credentialsPath: "/legacy.toml" });
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("clear the legacy");
      expect(cli.calls).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(makeCli({ missing: true }));
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("Binary path");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not launch ACP after a failing version command", () =>
    Effect.gen(function* () {
      const cli = makeCli({ versionCode: 1 });
      const snapshot = yield* check(cli);
      expect(snapshot.status).toBe("error");
      expect(cli.calls).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "uses the selected CLI and environment and only initializes, never creates a session",
    () =>
      Effect.gen(function* () {
        const cli = makeCli();
        const snapshot = yield* check(
          cli,
          { binaryPath: "/bin/devin-stable" },
          {
            XDG_DATA_HOME: "/isolated",
          },
        );
        expect(cli.requests).toEqual(["initialize"]);
        expect(cli.calls.map((call) => call.args)).toEqual([
          ["--version"],
          ["auth", "status"],
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
});
