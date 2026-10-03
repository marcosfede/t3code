import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpCompat from "effect-acp/compat";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeDevinCloudReconnect, type DevinCloudConnectOptions } from "./DevinCloudReconnect.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type Handler = (
  notification: AcpCompat.SessionNotification,
) => Effect.Effect<void, AcpErrors.AcpError>;

interface FakeConnection {
  readonly index: number;
  readonly options: DevinCloudConnectOptions;
  readonly handlers: Array<Handler>;
  readonly prompts: Array<Deferred.Deferred<AcpCompat.PromptResponse, AcpErrors.AcpError>>;
  readonly promptReceived: Deferred.Deferred<void>;
  readonly cancelled: Deferred.Deferred<void>;
}

const makeFakes = (dispatches: (index: number) => boolean = () => true) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<FakeConnection>();
    let count = 0;
    const connect = (options: DevinCloudConnectOptions) =>
      Effect.gen(function* () {
        const connection: FakeConnection = {
          index: count++,
          options,
          handlers: [],
          prompts: [],
          promptReceived: yield* Deferred.make<void>(),
          cancelled: yield* Deferred.make<void>(),
        };
        return {
          handleSessionUpdate: (handler: Handler) =>
            Effect.sync(() => {
              connection.handlers.push(handler);
            }),
          getEvents: () => Stream.never,
          drainEvents: Effect.void,
          start: () =>
            Queue.offer(started, connection).pipe(
              Effect.as({
                sessionId: "session-1",
                initializeResult: { protocolVersion: 1 },
                sessionSetupResult: { sessionId: "session-1" },
                modelConfigId: undefined,
              }),
            ),
          prompt: (
            _payload: unknown,
            promptOptions?: { readonly dispatched?: Deferred.Deferred<void> },
          ) =>
            Effect.gen(function* () {
              const result = yield* Deferred.make<AcpCompat.PromptResponse, AcpErrors.AcpError>();
              connection.prompts.push(result);
              if (promptOptions?.dispatched && dispatches(connection.index)) {
                yield* Deferred.succeed(promptOptions.dispatched, undefined);
              }
              yield* Deferred.succeed(connection.promptReceived, undefined);
              return yield* Deferred.await(result);
            }),
          cancel: Deferred.succeed(connection.cancelled, undefined).pipe(Effect.asVoid),
          processContainment: { kind: "none" },
        } as unknown as Runtime;
      });
    return { started, connect };
  });

const emit = (connection: FakeConnection, notification: AcpCompat.SessionNotification) =>
  Effect.forEach(connection.handlers, (handler) => handler(notification), { discard: true });

const chunk = (text: string, eventId: string): AcpCompat.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: { "cognition.ai/eventId": eventId },
  },
});

const status = (statusEnum: string, eventId: string): AcpCompat.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: "session_info_update",
    _meta: { "cognition.ai/eventId": eventId, "cognition.ai/statusEnum": statusEnum },
  },
});

const textOf = (notification: AcpCompat.SessionNotification) =>
  notification.update.sessionUpdate === "agent_message_chunk" &&
  notification.update.content.type === "text"
    ? [notification.update.content.text]
    : [];

const connectionLost = () => new AcpErrors.AcpProcessExitedError({ code: 1 });
const prompt = { prompt: [{ type: "text" as const, text: "hi" }] };

describe("makeDevinCloudReconnect", () => {
  it.effect("reconnects to the same session, skips replayed events and settles the prompt", () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes();
      const runtime = yield* makeDevinCloudReconnect({}, fakes.connect);
      const seen: Array<string> = [];
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.sync(() => seen.push(...textOf(notification))),
      );
      yield* runtime.start();
      const first = yield* Queue.take(fakes.started);
      yield* emit(first, chunk("before ", "e1"));
      const turn = yield* runtime.prompt(prompt).pipe(Effect.forkChild);
      yield* Deferred.await(first.promptReceived);

      yield* first.options.onTermination(connectionLost());
      const second = yield* Queue.take(fakes.started);
      expect(second.options.resumeSessionId).toBe("session-1");
      yield* emit(second, chunk("before ", "e1"));
      yield* emit(second, chunk("after", "e2"));
      yield* emit(second, status("finished", "e3"));

      expect(yield* Fiber.join(turn)).toEqual({ stopReason: "end_turn" });
      expect(seen).toEqual(["before ", "after"]);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("re-sends a prompt that never reached Cloud", () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes((index) => index > 0);
      const runtime = yield* makeDevinCloudReconnect({}, fakes.connect);
      yield* runtime.start();
      const first = yield* Queue.take(fakes.started);
      const turn = yield* runtime.prompt(prompt).pipe(Effect.forkChild);
      yield* Deferred.await(first.promptReceived);

      yield* Deferred.fail(first.prompts[0]!, connectionLost());
      yield* first.options.onTermination(connectionLost());
      const second = yield* Queue.take(fakes.started);
      yield* Deferred.await(second.promptReceived);
      yield* Deferred.succeed(second.prompts[0]!, { stopReason: "end_turn" });

      expect(yield* Fiber.join(turn)).toEqual({ stopReason: "end_turn" });
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("surfaces errors that are not a dropped connection", () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes();
      const terminations: Array<string> = [];
      const runtime = yield* makeDevinCloudReconnect(
        {
          onTermination: (error) => Effect.sync(() => terminations.push(error._tag)),
        },
        fakes.connect,
      );
      yield* runtime.start();
      const first = yield* Queue.take(fakes.started);
      const turn = yield* runtime.prompt(prompt).pipe(Effect.forkChild);
      yield* Deferred.await(first.promptReceived);

      yield* first.options.onTermination(
        new AcpErrors.AcpRequestError({ code: -32603, errorMessage: "boom" }),
      );

      const result = yield* Fiber.join(turn).pipe(Effect.flip);
      expect(result._tag).toBe("AcpRequestError");
      expect(terminations).toEqual(["AcpRequestError"]);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("holds cancellation until Cloud reports the session idle", () =>
    Effect.gen(function* () {
      const fakes = yield* makeFakes();
      const runtime = yield* makeDevinCloudReconnect({}, fakes.connect);
      yield* runtime.start();
      const first = yield* Queue.take(fakes.started);
      const turn = yield* runtime.prompt(prompt).pipe(Effect.forkChild);
      yield* Deferred.await(first.promptReceived);

      const cancel = yield* runtime.cancel.pipe(Effect.forkChild);
      yield* Deferred.await(first.cancelled);
      expect(cancel.pollUnsafe()).toBeUndefined();
      yield* emit(first, status("finished", "e1"));
      yield* Fiber.join(cancel);

      expect(yield* Fiber.join(turn)).toEqual({ stopReason: "cancelled" });
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
});
