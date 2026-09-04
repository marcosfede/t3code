import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { WebSocketServer, type WebSocket } from "ws";
import type * as AcpSchema from "effect-acp/schema";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";

import {
  buildDevinCloudAcpWebSocketUrl,
  defaultDevinCredentialsPath,
  DevinCloudCredentialsError,
  loadDevinCloudCredentials,
  makeDevinCloudAcpRuntime,
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

const sessionId = "devin-reconnect-test";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      result: Schema.optional(Schema.Unknown),
    }),
  ),
);

const sendUpdate = (
  socket: WebSocket,
  update: AcpSchema.SessionNotification["update"],
  replay = false,
) =>
  socket.send(
    encodeJson({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update, ...(replay ? { _meta: { isReplay: true } } : {}) },
    }),
  );

const messageUpdate = (id: string, text: string): AcpSchema.SessionNotification["update"] => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
  _meta: { "cognition.ai/eventId": id },
});

const statusUpdate = (status: string): AcpSchema.SessionNotification["update"] => ({
  sessionUpdate: "session_info_update",
  _meta: { "cognition.ai/eventType": "status_update", "cognition.ai/statusEnum": status },
});

const makeCloudServer = (
  onLoad?: (socket: WebSocket, request: ReturnType<typeof decodeRequest>) => boolean | void,
) =>
  Effect.gen(function* () {
    const connections = yield* Queue.unbounded<WebSocket>();
    const prompts = yield* Queue.unbounded<WebSocket>();
    const loads = yield* Queue.unbounded<WebSocket>();
    const failedLoads = yield* Queue.unbounded<void>();
    const cancellations = yield* Queue.unbounded<WebSocket>();
    const requests: Array<ReturnType<typeof decodeRequest>> = [];
    const responses = yield* Queue.unbounded<ReturnType<typeof decodeRequest>>();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resume(Effect.void));
        }),
    );
    server.on("connection", (socket) => {
      Queue.offerUnsafe(connections, socket);
      socket.on("message", (data) => {
        const request = decodeRequest(String(data));
        if (request.method === undefined) {
          Queue.offerUnsafe(responses, request);
          return;
        }
        requests.push(request);
        let result: unknown;
        switch (request.method) {
          case "initialize":
            result = {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [],
            };
            break;
          case "session/new":
            result = { sessionId };
            break;
          case "session/load":
            if (onLoad?.(socket, request) === false) {
              Queue.offerUnsafe(loads, socket);
              return;
            }
            result = { _meta: { "cognition.ai/statusEnum": "working" } };
            break;
          case "session/cancel":
            Queue.offerUnsafe(cancellations, socket);
            return;
          case "session/prompt":
            Queue.offerUnsafe(prompts, socket);
            return;
          default:
            result = {};
        }
        if (request.id !== undefined)
          socket.send(encodeJson({ jsonrpc: "2.0", id: request.id, result }));
        if (request.method === "session/load") Queue.offerUnsafe(loads, socket);
      });
    });
    yield* Effect.callback<void>((resume) => {
      server.once("listening", () => resume(Effect.void));
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      return yield* Effect.die("No test server address");
    const runtimeScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
    const runtime = yield* makeDevinCloudAcpRuntime({
      credentials: { apiUrl: `http://127.0.0.1:${address.port}`, token: "test" },
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      cwd: "/workspace",
      clientInfo: { name: "test", version: "1" },
      requestLogger: (event) =>
        event.method === "connection/reconnect" && event.status === "failed"
          ? Queue.offer(failedLoads, undefined).pipe(Effect.asVoid)
          : Effect.void,
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
    const deltas: string[] = [];
    const receivedDelta = yield* Queue.unbounded<string>();
    const activeItems = new Set<string>();
    const eventsFiber = yield* Stream.runForEach(runtime.getEvents(), (event) =>
      Effect.gen(function* () {
        if (event._tag === "AssistantItemStarted") activeItems.add(event.itemId);
        if (event._tag === "AssistantItemCompleted") activeItems.delete(event.itemId);
        if (event._tag === "EventStreamBarrier")
          yield* Deferred.succeed(event.acknowledge, undefined);
        if (event._tag === "ContentDelta") {
          deltas.push(event.text);
          yield* Queue.offer(receivedDelta, event.text);
        }
      }),
    ).pipe(Effect.forkScoped);
    yield* runtime.start();
    return {
      runtime,
      runtimeScope,
      requests,
      responses,
      connections,
      prompts,
      loads,
      failedLoads,
      cancellations,
      deltas,
      activeItems,
      eventsFiber,
      receivedDelta,
    };
  });

describe("Devin Cloud reconnection", () => {
  it.live("keeps the adapter turn running across a disconnect and settles it exactly once", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer();
      yield* Fiber.interrupt(server.eventsFiber);
      const provider = ProviderDriverKind.make("devinCloud");
      const threadId = ThreadId.make("cloud-reconnect-thread");
      const adapter = yield* makeDevinAdapter(null, {
        provider,
        makeAcpRuntime: () =>
          Effect.addFinalizer(() => Scope.close(server.runtimeScope, Exit.void)).pipe(
            Effect.as(server.runtime),
          ),
      });
      const events: ProviderRuntimeEvent[] = [];
      const requests =
        yield* Queue.unbounded<
          Extract<ProviderRuntimeEvent, { type: "request.opened" | "request.resolved" }>
        >();
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "request.opened" || event.type === "request.resolved")
            yield* Queue.offer(requests, event);
          if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "work", attachments: [] })
        .pipe(Effect.forkScoped);
      const socket = yield* Queue.take(server.prompts);
      const permission = encodeJson({
        jsonrpc: "2.0",
        id: "permission",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool", title: "Read file", kind: "read", status: "pending" },
          options: [{ optionId: "once", name: "Allow", kind: "allow_once" }],
        },
      });
      socket.send(permission);
      const firstRequest = yield* Queue.take(requests);
      expect(firstRequest.type).toBe("request.opened");
      socket.close(1012);
      expect(yield* Queue.take(requests)).toMatchObject({
        type: "request.resolved",
        requestId: firstRequest.requestId,
        payload: { decision: "cancel" },
      });
      const replacement = yield* Queue.take(server.loads);
      expect((yield* adapter.listSessions())[0]?.status).toBe("running");
      replacement.send(permission);
      const secondRequest = yield* Queue.take(requests);
      expect(secondRequest.type).toBe("request.opened");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(secondRequest.requestId)),
        "accept",
      );
      expect(yield* Queue.take(server.responses)).toMatchObject({
        result: { outcome: { outcome: "selected", optionId: "once" } },
      });
      sendUpdate(replacement, messageUpdate("final", "reconnected"));
      sendUpdate(replacement, statusUpdate("finished"));
      const result = yield* Fiber.join(turn);
      yield* Deferred.await(completed);
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { turnId: result.turnId, payload: { state: "completed" } },
      ]);
      expect(events.filter((event) => event.type === "session.exited")).toEqual([]);
      expect(events.filter((event) => event.type === "content.delta")).toMatchObject([
        { turnId: result.turnId, payload: { delta: "reconnected" } },
      ]);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-reconnect-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.live("settles a turn that finished while disconnected using the loaded session status", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket, request) => {
        sendUpdate(socket, messageUpdate("final", "finished while offline"), true);
        socket.send(
          encodeJson({
            jsonrpc: "2.0",
            id: request.id,
            result: { _meta: { "cognition.ai/statusEnum": "finished" } },
          }),
        );
        return false;
      });
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).terminate();
      expect((yield* Fiber.join(prompt)).stopReason).toBe("end_turn");
      yield* server.runtime.drainEvents;
      expect(server.deltas).toEqual(["finished while offline"]);
      expect(server.activeItems.size).toBe(0);
      expect(server.requests.filter((request) => request.method === "session/prompt")).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("uses a missed terminal replay event when the load snapshot is older", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket) => {
        sendUpdate(socket, messageUpdate("final", "done"), true);
        const update = statusUpdate("finished");
        sendUpdate(
          socket,
          { ...update, _meta: { ...update._meta, "cognition.ai/eventId": "terminal" } },
          true,
        );
      });
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).close(1012);
      expect((yield* Fiber.join(prompt)).stopReason).toBe("end_turn");
      yield* server.runtime.drainEvents;
      expect(server.deltas).toEqual(["done"]);
      expect(server.activeItems.size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("survives repeated disconnects during the same prompt", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer();
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).close(1012);
      const second = yield* Queue.take(server.loads);
      yield* server.runtime.start();
      second.terminate();
      const third = yield* Queue.take(server.loads);
      yield* server.runtime.start();
      sendUpdate(third, statusUpdate("blocked"));
      expect((yield* Fiber.join(prompt)).stopReason).toBe("end_turn");
      expect(server.requests.filter((request) => request.method === "session/prompt")).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("allows Stop while reconnecting and sends cancellation before the next prompt", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer(() => false);
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).close(1012);
      const replacement = yield* Queue.take(server.loads);
      yield* server.runtime.cancel;
      expect((yield* Fiber.join(prompt)).stopReason).toBe("cancelled");
      const load = server.requests.find((request) => request.method === "session/load")!;
      replacement.send(encodeJson({ jsonrpc: "2.0", id: load.id, result: {} }));
      yield* Queue.take(server.cancellations);
      const next = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "next" }] })
        .pipe(Effect.forkScoped);
      yield* Queue.take(server.prompts);
      const nextRequest = server.requests.findLast(
        (request) => request.method === "session/prompt",
      )!;
      replacement.send(
        encodeJson({ jsonrpc: "2.0", id: nextRequest.id, result: { stopReason: "end_turn" } }),
      );
      expect((yield* Fiber.join(next)).stopReason).toBe("end_turn");
      const methods = server.requests.map((request) => request.method);
      expect(methods.indexOf("session/cancel")).toBeLessThan(methods.lastIndexOf("session/prompt"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops after five failed reconnect attempts and fails the pending turn", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket) => {
        socket.close(1012);
        return false;
      });
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).close(1012);
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* Queue.take(server.loads);
        yield* Queue.take(server.failedLoads);
        yield* TestClock.adjust("10 seconds");
      }
      const failure = yield* server.runtime.awaitTermination.pipe(Effect.flip);
      expect(failure._tag).toBe("AcpProcessExitedError");
      expect((yield* Fiber.join(prompt).pipe(Effect.flip))._tag).toBe("AcpProcessExitedError");
      expect(server.requests.filter((request) => request.method === "session/load")).toHaveLength(
        5,
      );
      yield* server.runtime.drainEvents;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries an unresponsive reload after its deadline", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const server = yield* makeCloudServer(() => ++attempts > 1);
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      (yield* Queue.take(server.prompts)).close(1012);
      yield* Queue.take(server.loads);
      yield* TestClock.adjust("20 seconds");
      yield* Queue.take(server.failedLoads);
      yield* TestClock.adjust("10 seconds");
      const replacement = yield* Queue.take(server.loads);
      yield* server.runtime.start();
      sendUpdate(replacement, statusUpdate("finished"));
      expect((yield* Fiber.join(prompt)).stopReason).toBe("end_turn");
      expect(attempts).toBe(2);
      expect(server.requests.filter((request) => request.method === "session/prompt")).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closing a session cancels a reconnect in backoff", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket) => {
        socket.close(1012);
        return false;
      });
      (yield* Queue.take(server.connections)).close(1012);
      yield* Queue.take(server.loads);
      yield* Scope.close(server.runtimeScope, Exit.void);
      yield* TestClock.adjust("1 minute");
      expect(server.requests.filter((request) => request.method === "session/load")).toHaveLength(
        1,
      );
      expect((yield* server.runtime.awaitTermination.pipe(Effect.flip))._tag).toBe(
        "AcpTransportError",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not retry a session access error", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket, request) => {
        socket.send(
          encodeJson({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32002, message: "Access denied" },
          }),
        );
        return false;
      });
      (yield* Queue.take(server.connections)).close(1012);
      expect((yield* server.runtime.awaitTermination.pipe(Effect.flip))._tag).toBe(
        "AcpTransportError",
      );
      expect(server.requests.filter((request) => request.method === "session/load")).toHaveLength(
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reconnects an active prompt without resending it and replays only missed messages", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer((socket) => {
        sendUpdate(socket, messageUpdate("old", "before disconnect"), true);
        sendUpdate(socket, messageUpdate("new", "during disconnect"), true);
      });
      const prompt = yield* server.runtime
        .prompt({ prompt: [{ type: "text", text: "work" }] })
        .pipe(Effect.forkScoped);
      const socket = yield* Queue.take(server.prompts);
      sendUpdate(socket, messageUpdate("old", "before disconnect"));
      expect(yield* Queue.take(server.receivedDelta)).toBe("before disconnect");
      socket.close(1012, "service restart");
      const replacement = yield* Queue.take(server.loads);
      expect(yield* Queue.take(server.receivedDelta)).toBe("during disconnect");
      sendUpdate(replacement, messageUpdate("last", "after reconnect"));
      sendUpdate(replacement, statusUpdate("finished"));
      expect((yield* Fiber.join(prompt)).stopReason).toBe("end_turn");
      yield* server.runtime.drainEvents;
      expect(server.deltas).toEqual(["before disconnect", "during disconnect", "after reconnect"]);
      expect(server.requests.filter((request) => request.method === "session/prompt")).toHaveLength(
        1,
      );
      expect(
        server.requests.find((request) => request.method === "session/load")?.params?.sessionId,
      ).toBe(sessionId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reconnects while idle before another prompt is sent", () =>
    Effect.gen(function* () {
      const server = yield* makeCloudServer();
      const socket = yield* Queue.take(server.connections);
      socket.close(1012);
      yield* Queue.take(server.loads);
      expect((yield* server.runtime.start()).sessionId).toBe(sessionId);
      expect(server.requests.filter((request) => request.method === "session/new")).toHaveLength(1);
      expect(server.requests.filter((request) => request.method === "session/prompt")).toHaveLength(
        0,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
