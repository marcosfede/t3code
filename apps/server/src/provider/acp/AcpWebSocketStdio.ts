import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AcpWebSocketStdioHandle {
  readonly stdio: Stdio.Stdio;
  readonly terminationError: Effect.Effect<EffectAcpErrors.AcpError>;
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

/** Connects a WebSocket that carries NDJSON JSON-RPC frames (one message per
 * frame) and adapts it to the `Stdio` shape the ACP client consumes. The
 * socket is closed when the surrounding scope closes. */
export const connectAcpWebSocketStdio = Effect.fn("connectAcpWebSocketStdio")(function* (
  url: string,
): Effect.fn.Return<AcpWebSocketStdioHandle, EffectAcpErrors.AcpSpawnError, Scope.Scope> {
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
    ws.binaryType = "arraybuffer";
    ws.addEventListener(
      "open",
      () => {
        resume(Effect.succeed(ws));
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        resume(
          Effect.fail(
            new EffectAcpErrors.AcpSpawnError({
              command: displayUrl,
              cause: new Error("WebSocket connection failed"),
            }),
          ),
        );
      },
      { once: true },
    );
    return Effect.sync(() => {
      ws.close();
    });
  });

  let finalized = false;
  socket.addEventListener("error", () => {
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
  socket.addEventListener("close", (event) => {
    if (!finalized) {
      Deferred.doneUnsafe(
        closed,
        Effect.fail(
          new EffectAcpErrors.AcpProcessExitedError({
            code: event.code === 1000 ? 0 : event.code,
          }),
        ),
      );
    }
    Queue.endUnsafe(incoming);
  });
  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;
    const text =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? decoder.decode(data)
          : undefined;
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
  };
});
