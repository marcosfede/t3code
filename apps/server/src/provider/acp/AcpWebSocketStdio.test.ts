import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { WebSocketServer, type WebSocket as ServerWebSocket } from "ws";

import { connectAcpWebSocketStdio } from "./AcpWebSocketStdio.ts";

interface TestServer {
  readonly url: string;
  readonly received: Array<string>;
  readonly connections: Array<ServerWebSocket>;
  readonly close: Effect.Effect<void>;
}

const makeServer = (options?: { readonly pauseSocket?: boolean }) =>
  Effect.acquireRelease(
    Effect.callback<TestServer>((resume) => {
      const received: Array<string> = [];
      const connections: Array<ServerWebSocket> = [];
      const server = new WebSocketServer({ port: 0 });
      server.on("connection", (ws, request) => {
        connections.push(ws);
        ws.on("message", (data) => {
          received.push(String(data));
        });
        if (options?.pauseSocket) {
          // Stop reading from the raw TCP socket: client pings are never
          // processed, so no pongs come back — a silently dead connection.
          request.socket.pause();
        }
      });
      server.on("listening", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            url: `ws://127.0.0.1:${port}`,
            received,
            connections,
            close: Effect.callback<void>((resumeClose) => {
              for (const ws of connections) {
                ws.terminate();
              }
              server.close(() => {
                resumeClose(Effect.void);
              });
            }),
          }),
        );
      });
    }),
    (server) => server.close,
  );

describe("connectAcpWebSocketStdio", () => {
  it.live("bridges NDJSON lines in both directions", () =>
    Effect.gen(function* () {
      const server = yield* makeServer();
      const handle = yield* connectAcpWebSocketStdio(server.url);

      // Outbound: chunks buffer until a complete newline-delimited line.
      const writeChunk = (chunk: string) =>
        Stream.make(chunk).pipe(Stream.run(handle.stdio.stdout()));
      yield* writeChunk('{"jsonrpc":"2.0",');
      yield* writeChunk('"id":1}\n');
      yield* Effect.sleep(50);
      expect(server.received).toEqual(['{"jsonrpc":"2.0","id":1}']);

      // Inbound: server frames surface as newline-terminated stdin data.
      const firstLine = Stream.runCollect(handle.stdio.stdin.pipe(Stream.take(1))).pipe(
        Effect.map((chunks) => new TextDecoder().decode(chunks[0])),
      );
      const reader = yield* Effect.forkChild(firstLine);
      server.connections[0]!.send('{"jsonrpc":"2.0","result":{}}');
      expect(yield* Fiber.join(reader)).toBe('{"jsonrpc":"2.0","result":{}}\n');
    }).pipe(Effect.scoped),
  );

  it.live("fails termination with AcpProcessExitedError on abnormal close", () =>
    Effect.gen(function* () {
      const server = yield* makeServer();
      const handle = yield* connectAcpWebSocketStdio(server.url);
      server.connections[0]!.terminate();
      const error = yield* handle.terminationError;
      expect(error._tag).toBe("AcpProcessExitedError");
      // stdin ends so the ACP protocol loop terminates too.
      yield* handle.stdio.stdin.pipe(Stream.run(Sink.drain));
    }).pipe(Effect.scoped),
  );

  it.live("terminates a silently dead connection via the heartbeat", () =>
    Effect.gen(function* () {
      const server = yield* makeServer({ pauseSocket: true });
      const handle = yield* connectAcpWebSocketStdio(server.url, { heartbeatIntervalMs: 50 });
      const error = yield* handle.terminationError.pipe(Effect.timeout(2_000));
      expect(error._tag).toBe("AcpProcessExitedError");
    }).pipe(Effect.scoped),
  );

  it.live("fails to connect when no server is listening", () =>
    Effect.gen(function* () {
      const result = yield* connectAcpWebSocketStdio("ws://127.0.0.1:1").pipe(Effect.flip);
      expect(result._tag).toBe("AcpSpawnError");
    }).pipe(Effect.scoped),
  );
});
