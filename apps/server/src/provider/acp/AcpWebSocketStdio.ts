import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import { WebSocket } from "ws";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How often a ping frame is sent to prove the connection is alive. A peer
 * that misses a whole interval without ponging is treated as dead, so a
 * silently dropped connection (e.g. a network change with no FIN/RST) is
 * detected within roughly two intervals instead of hanging forever. */
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface AcpWebSocketStdioOptions {
  readonly heartbeatIntervalMs?: number;
}

export interface AcpWebSocketStdioHandle {
  readonly stdio: Stdio.Stdio;
  readonly terminationError: Effect.Effect<EffectAcpErrors.AcpError>;
  /** Closes the socket; the close handler then settles `terminationError`. */
  readonly close: Effect.Effect<void>;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, "<redacted>");
    }
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

function messageText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return decoder.decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return decoder.decode(data as Uint8Array);
  }
  if (Array.isArray(data)) {
    return data.map((part) => messageText(part) ?? "").join("");
  }
  return undefined;
}

/** Connects a WebSocket that carries NDJSON JSON-RPC frames (one message per
 * frame) and adapts it to the `Stdio` shape the ACP client consumes. The
 * socket is closed when the surrounding scope closes, and a ping/pong
 * heartbeat terminates connections that die without a close frame. */
export const connectAcpWebSocketStdio = Effect.fn("connectAcpWebSocketStdio")(function* (
  url: string,
  options?: AcpWebSocketStdioOptions,
): Effect.fn.Return<AcpWebSocketStdioHandle, EffectAcpErrors.AcpSpawnError, Scope.Scope> {
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const displayUrl = redactUrl(url);
  const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const closed = yield* Deferred.make<never, EffectAcpErrors.AcpError>();

  const socket = yield* Effect.callback<WebSocket, EffectAcpErrors.AcpSpawnError>((resume) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (cause) {
      resume(Effect.fail(new EffectAcpErrors.AcpSpawnError({ command: displayUrl, cause })));
      return;
    }
    ws.once("open", () => {
      resume(Effect.succeed(ws));
    });
    ws.once("error", (cause) => {
      resume(Effect.fail(new EffectAcpErrors.AcpSpawnError({ command: displayUrl, cause })));
    });
    return Effect.sync(() => {
      ws.close();
    });
  });

  let finalized = false;
  let peerAlive = true;
  yield* Effect.sync(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (!peerAlive) {
      // No pong since the previous ping: the connection is dead even though
      // the OS never surfaced a close. Terminate so the close handler runs.
      socket.terminate();
      return;
    }
    peerAlive = false;
    socket.ping();
  }).pipe(
    Effect.delay(heartbeatIntervalMs),
    Effect.repeat(Schedule.spaced(heartbeatIntervalMs)),
    Effect.forkScoped,
  );
  socket.on("pong", () => {
    peerAlive = true;
  });
  socket.on("error", () => {
    Deferred.doneUnsafe(
      closed,
      Effect.fail(
        new EffectAcpErrors.AcpTransportError({
          operation: "read-input-stream",
          detail: `WebSocket error: ${displayUrl}`,
          cause: new Error("WebSocket error"),
        }),
      ),
    );
  });
  socket.on("close", (code) => {
    if (!finalized) {
      Deferred.doneUnsafe(
        closed,
        Effect.fail(
          new EffectAcpErrors.AcpProcessExitedError({
            code: code === 1000 ? 0 : code,
          }),
        ),
      );
    }
    Queue.endUnsafe(incoming);
  });
  socket.on("message", (data) => {
    const text = messageText(data);
    if (text !== undefined) {
      Queue.offerUnsafe(incoming, encoder.encode(text.endsWith("\n") ? text : `${text}\n`));
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      finalized = true;
      Queue.endUnsafe(incoming);
      socket.close();
    }),
  );

  let outgoingBuffer = "";
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(incoming),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          outgoingBuffer += typeof chunk === "string" ? chunk : decoder.decode(chunk);
          let newlineIndex = outgoingBuffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = outgoingBuffer.slice(0, newlineIndex).trim();
            outgoingBuffer = outgoingBuffer.slice(newlineIndex + 1);
            if (line.length > 0 && socket.readyState === WebSocket.OPEN) {
              socket.send(line);
            }
            newlineIndex = outgoingBuffer.indexOf("\n");
          }
        }),
      ),
    stderr: () => Sink.drain,
  });

  return {
    stdio,
    terminationError: Deferred.await(closed).pipe(Effect.flip),
    close: Effect.sync(() => socket.close()),
  };
});
