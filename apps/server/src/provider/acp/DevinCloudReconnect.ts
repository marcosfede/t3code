import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import type {
  AcpSessionRuntime,
  AcpSessionRuntimeEvent,
  AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime.ts";
import { sessionUpdateIsReplay } from "./AcpRuntimeModel.ts";

type Runtime = AcpSessionRuntime["Service"];
type PendingPrompt = {
  readonly completion: Deferred.Deferred<AcpSchema.PromptResponse, AcpErrors.AcpError>;
  readonly dispatched: Deferred.Deferred<void>;
  recovering: boolean;
};

const isConnectionLost = (error: AcpErrors.AcpError) =>
  error._tag === "AcpProcessExitedError" ||
  error._tag === "AcpTransportError" ||
  error._tag === "AcpInputStreamEndedError" ||
  error._tag === "AcpSpawnError";

function stopReason(meta: unknown): AcpSchema.StopReason | undefined {
  if (!Predicate.isObject(meta)) return undefined;
  if (meta["cognition.ai/statusReason"] === "resume_restored") return undefined;
  if (meta["cognition.ai/eventType"] === "devin_exited") return "refusal";
  switch (meta["cognition.ai/statusEnum"]) {
    case "finished":
    case "blocked":
      return "end_turn";
    case "crashed":
      return "refusal";
    default:
      return undefined;
  }
}

export const makeDevinCloudReconnect = Effect.fn("makeDevinCloudReconnect")(function* (
  options: Pick<AcpSessionRuntimeOptions, "resumeSessionId" | "requestLogger">,
  connect: (
    options: Pick<
      AcpSessionRuntimeOptions,
      "resumeSessionId" | "acceptSessionUpdate" | "onSessionUpdate"
    >,
  ) => Effect.Effect<Runtime, AcpErrors.AcpError, Crypto.Crypto | Scope.Scope>,
): Effect.fn.Return<Runtime, AcpErrors.AcpError, Crypto.Crypto | Scope.Scope> {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const events = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const terminated = yield* Deferred.make<never, AcpErrors.AcpError>();
  const closed = yield* Deferred.make<void>();
  const pending = new Set<PendingPrompt>();
  const registrations: Array<(runtime: Runtime) => Effect.Effect<void>> = [];
  const delivered = new Set<string>();
  const replacements = new WeakMap<Runtime, Deferred.Deferred<Runtime, AcpErrors.AcpError>>();
  let sessionId = options.resumeSessionId;
  let watching = false;
  let reconnecting = false;
  let cancelOnReconnect = false;

  const settleRecovered = (runtime: Runtime, reason: AcpSchema.StopReason) =>
    Effect.gen(function* () {
      if (![...pending].some((prompt) => prompt.recovering)) return;
      yield* runtime.finishPrompt;
      for (const prompt of pending) {
        if (prompt.recovering) yield* Deferred.succeed(prompt.completion, { stopReason: reason });
      }
    });

  const makeConnection = Effect.fn("DevinCloudReconnect.connect")(function* (recovering: boolean) {
    const connectionScope = yield* Scope.fork(scope, "sequential");
    const previous = new Set(delivered);
    let ready = false;
    let observedStatus = false;
    let latestStopReason: AcpSchema.StopReason | undefined;
    const result = yield* Effect.gen(function* () {
      const runtime: Runtime = yield* connect({
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        ...(recovering
          ? {
              acceptSessionUpdate: (notification: AcpSchema.SessionNotification) => {
                if (notification.sessionId !== sessionId) return false;
                if (!sessionUpdateIsReplay(notification)) return true;
                const id = notification.update._meta?.["cognition.ai/eventId"];
                return typeof id === "string" && !previous.has(id);
              },
            }
          : {}),
        onSessionUpdate: (notification) =>
          Effect.gen(function* () {
            if (notification.sessionId !== sessionId) return;
            const meta = notification.update._meta;
            const id = meta?.["cognition.ai/eventId"];
            if (typeof id === "string") delivered.add(id);
            if (
              !recovering ||
              (sessionUpdateIsReplay(notification) && (typeof id !== "string" || previous.has(id)))
            )
              return;
            if (
              meta?.["cognition.ai/statusEnum"] !== undefined ||
              meta?.["cognition.ai/eventType"] === "devin_exited"
            ) {
              observedStatus = true;
              latestStopReason = stopReason(meta);
              if (ready && latestStopReason) yield* settleRecovered(runtime, latestStopReason);
            }
          }),
      }).pipe(
        Effect.provideService(Scope.Scope, connectionScope),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      for (const register of registrations) yield* register(runtime);
      yield* Stream.runForEach(runtime.getEvents(), (event) =>
        event._tag === "ConnectionTerminated" ? Effect.void : Queue.offer(events, event),
      ).pipe(Effect.forkIn(connectionScope));
      if (recovering) {
        const started = yield* runtime.start();
        if (started.sessionId !== sessionId)
          return yield* new AcpErrors.AcpTransportError({
            detail: "Devin Cloud reconnected to a different session.",
            cause: undefined,
          });
        ready = true;
        if (!observedStatus) latestStopReason = stopReason(started.sessionSetupResult._meta);
        if (cancelOnReconnect) {
          yield* runtime.cancel;
          cancelOnReconnect = false;
        } else if (latestStopReason) yield* settleRecovered(runtime, latestStopReason);
      }
      const replacement = yield* Deferred.make<Runtime, AcpErrors.AcpError>();
      replacements.set(runtime, replacement);
      return { runtime, scope: connectionScope, replacement };
    }).pipe(Effect.onError(() => Scope.close(connectionScope, Exit.void)));
    return result;
  });

  let current = yield* makeConnection(false);
  let available = yield* Deferred.make<Runtime, AcpErrors.AcpError>();
  yield* Deferred.succeed(available, current.runtime);
  const connected = Effect.suspend(() => Deferred.await(available));

  const fail = Effect.fn("DevinCloudReconnect.fail")(function* (error: AcpErrors.AcpError) {
    yield* Deferred.fail(available, error);
    yield* Deferred.fail(current.replacement, error);
    yield* Deferred.fail(terminated, error);
    for (const prompt of pending) yield* Deferred.fail(prompt.completion, error);
    yield* Queue.offer(events, { _tag: "ConnectionTerminated", error });
  });

  const watch = Effect.gen(function* () {
    while (true) {
      const error = yield* current.runtime.awaitTermination.pipe(Effect.flip);
      if (!isConnectionLost(error)) return yield* fail(error);
      reconnecting = true;
      available = yield* Deferred.make<Runtime, AcpErrors.AcpError>();
      for (const prompt of pending) prompt.recovering = yield* Deferred.isDone(prompt.dispatched);
      yield* current.runtime.drainEvents;
      yield* Scope.close(current.scope, Exit.void);
      const replacement = yield* makeConnection(true).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.fail(
              new AcpErrors.AcpTransportError({
                detail: "Devin Cloud reconnection timed out.",
                cause: undefined,
              }),
            ),
        }),
        Effect.tapError(
          (error) =>
            options.requestLogger?.({
              method: "connection/reconnect",
              payload: { sessionId },
              status: "failed",
              cause: Cause.fail(error),
            }) ?? Effect.void,
        ),
        Effect.retry({
          times: 4,
          schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          while: isConnectionLost,
        }),
        Effect.result,
      );
      if (replacement._tag === "Failure") return yield* fail(replacement.failure);
      const previous = current;
      current = replacement.success;
      reconnecting = false;
      yield* Deferred.succeed(available, current.runtime);
      yield* Deferred.succeed(previous.replacement, current.runtime);
    }
  }).pipe(
    Effect.catchDefect((cause) =>
      fail(
        new AcpErrors.AcpTransportError({
          detail: "Devin Cloud reconnection failed.",
          cause,
        }),
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(closed, undefined);
      const error = new AcpErrors.AcpTransportError({
        detail: "Devin Cloud session is closed.",
        cause: undefined,
      });
      yield* Deferred.fail(available, error);
      yield* Deferred.fail(current.replacement, error);
      yield* Deferred.fail(terminated, error);
      for (const prompt of pending) yield* Deferred.fail(prompt.completion, error);
    }),
  );

  const register = (install: (runtime: Runtime) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      registrations.push(install);
      if (!reconnecting) yield* install(current.runtime);
    });
  const drainEvents = Effect.gen(function* () {
    yield* (yield* connected).drainEvents;
    const acknowledge = yield* Deferred.make<void>();
    yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
    yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(closed));
  }).pipe(Effect.ignore);

  return {
    handleRequestPermission: (handler) =>
      register((runtime) => runtime.handleRequestPermission(handler)),
    handleElicitation: (handler) => register((runtime) => runtime.handleElicitation(handler)),
    handleReadTextFile: (handler) => register((runtime) => runtime.handleReadTextFile(handler)),
    handleWriteTextFile: (handler) => register((runtime) => runtime.handleWriteTextFile(handler)),
    handleCreateTerminal: (handler) => register((runtime) => runtime.handleCreateTerminal(handler)),
    handleTerminalOutput: (handler) => register((runtime) => runtime.handleTerminalOutput(handler)),
    handleTerminalWaitForExit: (handler) =>
      register((runtime) => runtime.handleTerminalWaitForExit(handler)),
    handleTerminalKill: (handler) => register((runtime) => runtime.handleTerminalKill(handler)),
    handleTerminalRelease: (handler) =>
      register((runtime) => runtime.handleTerminalRelease(handler)),
    handleSessionUpdate: (handler) => register((runtime) => runtime.handleSessionUpdate(handler)),
    handleElicitationComplete: (handler) =>
      register((runtime) => runtime.handleElicitationComplete(handler)),
    handleUnknownExtRequest: (handler) =>
      register((runtime) => runtime.handleUnknownExtRequest(handler)),
    handleUnknownExtNotification: (handler) =>
      register((runtime) => runtime.handleUnknownExtNotification(handler)),
    handleExtRequest: (method, schema, handler) =>
      register((runtime) => runtime.handleExtRequest(method, schema, handler)),
    handleExtNotification: (method, schema, handler) =>
      register((runtime) => runtime.handleExtNotification(method, schema, handler)),
    initialize: () => connected.pipe(Effect.flatMap((runtime) => runtime.initialize())),
    start: () =>
      Effect.gen(function* () {
        const started = yield* (yield* connected).start();
        sessionId = started.sessionId;
        if (!watching) {
          watching = true;
          yield* watch.pipe(Effect.forkIn(scope));
        }
        return started;
      }),
    getEvents: () => Stream.fromQueue(events),
    drainEvents,
    finishPrompt: Effect.suspend(() => current.runtime.finishPrompt),
    getModeState: Effect.suspend(() => current.runtime.getModeState),
    getConfigOptions: Effect.suspend(() => current.runtime.getConfigOptions),
    prompt: (payload, promptOptions) =>
      Effect.gen(function* () {
        const runtime = yield* connected;
        const completion = yield* Deferred.make<AcpSchema.PromptResponse, AcpErrors.AcpError>();
        const dispatched = promptOptions?.dispatched ?? (yield* Deferred.make<void>());
        const prompt: PendingPrompt = { completion, dispatched, recovering: false };
        pending.add(prompt);
        const send = (
          runtime: Runtime,
        ): Effect.Effect<AcpSchema.PromptResponse, AcpErrors.AcpError> =>
          runtime.prompt(payload, { dispatched }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (!isConnectionLost(error)) return yield* error;
                if (!(yield* Deferred.isDone(dispatched))) {
                  const replacement = replacements.get(runtime);
                  if (!replacement) return yield* error;
                  const next = yield* Deferred.await(replacement);
                  if (yield* Deferred.isDone(completion)) return yield* Deferred.await(completion);
                  return yield* send(next);
                }
                return yield* Effect.raceFirst(
                  Deferred.await(completion),
                  Deferred.await(terminated),
                );
              }),
            ),
          );
        return yield* send(runtime).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(prompt))),
        );
      }),
    cancel: Effect.gen(function* () {
      for (const prompt of pending)
        yield* Deferred.succeed(prompt.completion, { stopReason: "cancelled" });
      if (reconnecting) {
        cancelOnReconnect = true;
        return;
      }
      yield* (yield* connected).cancel;
    }),
    setMode: (mode) => connected.pipe(Effect.flatMap((runtime) => runtime.setMode(mode))),
    setConfigOption: (id, value) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.setConfigOption(id, value))),
    setModel: (model) => connected.pipe(Effect.flatMap((runtime) => runtime.setModel(model))),
    setSessionModel: (model, meta) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.setSessionModel(model, meta))),
    request: (method, payload) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.request(method, payload))),
    notify: (method, payload) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.notify(method, payload))),
    awaitTermination: Deferred.await(terminated),
  } satisfies Runtime;
});
