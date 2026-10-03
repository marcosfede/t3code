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
import type * as AcpCompat from "effect-acp/compat";

import type {
  AcpSessionRuntime,
  AcpSessionRuntimeEvent,
  AcpSessionRuntimeOptions,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntime.ts";

type Runtime = AcpSessionRuntime["Service"];
type Notification = AcpCompat.SessionNotification;
type PendingPrompt = {
  readonly completion: Deferred.Deferred<AcpCompat.PromptResponse, AcpErrors.AcpError>;
  readonly dispatched: Deferred.Deferred<void>;
  recovering: boolean;
};
type Registration = (
  runtime: Runtime,
  accepts: (notification: Notification) => boolean,
) => Effect.Effect<void>;

export interface DevinCloudConnectOptions {
  readonly resumeSessionId?: string;
  readonly onTermination: (error: AcpErrors.AcpError) => Effect.Effect<void>;
}

export const isConnectionLost = (error: AcpErrors.AcpError) =>
  error._tag === "AcpProcessExitedError" ||
  error._tag === "AcpTransportError" ||
  error._tag === "AcpInputStreamEndedError" ||
  error._tag === "AcpSpawnError";

function updateMeta(notification: Notification): Record<string, unknown> | undefined {
  const meta = "_meta" in notification.update ? notification.update._meta : undefined;
  return Predicate.isObject(meta) ? (meta as Record<string, unknown>) : undefined;
}

function eventId(notification: Notification): string | undefined {
  const id = updateMeta(notification)?.["cognition.ai/eventId"];
  return typeof id === "string" ? id : undefined;
}

function stopReason(meta: unknown): AcpCompat.StopReason | undefined {
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

/**
 * Keeps a Devin Cloud session alive across dropped `devin acp --cloud` connections.
 * The session itself runs on Devin's machines, so a lost CLI connection reconnects
 * to the same session, replays it, and settles the in-flight prompt from the replay.
 */
export const makeDevinCloudReconnect = Effect.fn("makeDevinCloudReconnect")(function* (
  options: Pick<AcpSessionRuntimeOptions, "resumeSessionId" | "requestLogger" | "onTermination">,
  connect: (
    options: DevinCloudConnectOptions,
  ) => Effect.Effect<Runtime, AcpErrors.AcpError, Crypto.Crypto | Scope.Scope>,
): Effect.fn.Return<Runtime, AcpErrors.AcpError, Crypto.Crypto | Scope.Scope> {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const events = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
  const terminated = yield* Deferred.make<never, AcpErrors.AcpError>();
  const closed = yield* Deferred.make<void>();
  const pending = new Set<PendingPrompt>();
  const registrations: Array<Registration> = [];
  const delivered = new Set<string>();
  const replacements = new WeakMap<Runtime, Deferred.Deferred<Runtime, AcpErrors.AcpError>>();
  let sessionId = options.resumeSessionId;
  let reconnecting = false;
  let cancelOnReconnect = false;
  let idleAfterCancel: Deferred.Deferred<void> | undefined;

  const settleRecovered = (reason: AcpCompat.StopReason) =>
    Effect.forEach(
      [...pending].filter((prompt) => prompt.recovering),
      (prompt) => Deferred.succeed(prompt.completion, { stopReason: reason }),
      { discard: true },
    );

  // Cloud answers session/cancel with the cancelled prompt response first and an idle
  // status update shortly after. A prompt that reaches Cloud between the two is answered
  // with an immediate end_turn and never runs, so cancellation holds until that status
  // lands (or a bounded wait elapses, should Cloud ever stop sending it).
  // Cancelling only detaches the prompt: Devin keeps executing whatever it was doing
  // and reports that work inside the next prompt. Cloud exposes no stronger stop.
  const cancelSession = (runtime: Runtime) =>
    Effect.gen(function* () {
      const idle = yield* Deferred.make<void>();
      idleAfterCancel = idle;
      yield* runtime.cancel;
      yield* Deferred.await(idle).pipe(Effect.timeoutOption("5 seconds"));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          idleAfterCancel = undefined;
        }),
      ),
    );

  // Cloud's session/load replays the whole event log without marking replays, so a
  // recovering connection drops every event the previous connections already delivered.
  const makeConnection = Effect.fn("DevinCloudReconnect.connect")(function* (recovering: boolean) {
    const connectionScope = yield* Scope.fork(scope, "sequential");
    const lost = yield* Deferred.make<never, AcpErrors.AcpError>();
    const previous = new Set(delivered);
    const alreadyDelivered = (notification: Notification) => {
      const id = eventId(notification);
      return id !== undefined && previous.has(id);
    };
    const accepts = (notification: Notification) =>
      !recovering || (notification.sessionId === sessionId && !alreadyDelivered(notification));
    let ready = false;
    let observedStatus = false;
    let latestStopReason: AcpCompat.StopReason | undefined;
    const track = (notification: Notification) =>
      Effect.gen(function* () {
        const id = eventId(notification);
        const duplicate = alreadyDelivered(notification);
        if (id !== undefined) delivered.add(id);
        if (duplicate || notification.sessionId !== sessionId) return;
        const meta = updateMeta(notification);
        if (
          meta?.["cognition.ai/statusEnum"] === undefined &&
          meta?.["cognition.ai/eventType"] !== "devin_exited"
        ) {
          return;
        }
        const reason = stopReason(meta);
        if (reason && idleAfterCancel) yield* Deferred.succeed(idleAfterCancel, undefined);
        if (!recovering) return;
        observedStatus = true;
        latestStopReason = reason;
        if (ready && reason) yield* settleRecovered(reason);
      });
    return yield* Effect.gen(function* () {
      const runtime = yield* connect({
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        onTermination: (error) => Deferred.fail(lost, error).pipe(Effect.asVoid),
      }).pipe(
        Effect.provideService(Scope.Scope, connectionScope),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      yield* runtime.handleSessionUpdate(track);
      for (const register of registrations) yield* register(runtime, accepts);
      yield* Stream.runForEach(runtime.getEvents(), (event) =>
        event._tag === "ConnectionTerminated" ? Effect.void : Queue.offer(events, event),
      ).pipe(Effect.forkIn(connectionScope));
      if (recovering) {
        const started = yield* runtime.start();
        if (started.sessionId !== sessionId) {
          return yield* new AcpErrors.AcpTransportError({
            detail: "Devin Cloud reconnected to a different session.",
            cause: undefined,
          });
        }
        ready = true;
        if (!observedStatus) latestStopReason = stopReason(started.sessionSetupResult._meta);
        if (cancelOnReconnect) {
          yield* cancelSession(runtime);
          cancelOnReconnect = false;
        } else if (latestStopReason) {
          yield* settleRecovered(latestStopReason);
        }
      }
      const replacement = yield* Deferred.make<Runtime, AcpErrors.AcpError>();
      replacements.set(runtime, replacement);
      return { runtime, scope: connectionScope, lost, replacement };
    }).pipe(Effect.onError(() => Scope.close(connectionScope, Exit.void)));
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
    if (options.onTermination) yield* options.onTermination(error);
  });

  const reconnect = (error: AcpErrors.AcpError) =>
    Effect.gen(function* () {
      reconnecting = true;
      available = yield* Deferred.make<Runtime, AcpErrors.AcpError>();
      for (const prompt of pending) prompt.recovering = yield* Deferred.isDone(prompt.dispatched);
      yield* Effect.logWarning("Devin Cloud connection lost; reconnecting", {
        sessionId,
        cause: error._tag,
      });
      yield* current.runtime.drainEvents.pipe(Effect.timeoutOption("2 seconds"));
      yield* Scope.close(current.scope, Exit.void);
      return yield* makeConnection(true).pipe(
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
          (cause) =>
            options.requestLogger?.({
              method: "connection/reconnect",
              payload: { sessionId },
              status: "failed",
              cause: Cause.fail(cause),
            }) ?? Effect.void,
        ),
        Effect.retry({
          times: 4,
          schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          while: isConnectionLost,
        }),
        Effect.result,
      );
    });

  const watch = Effect.gen(function* () {
    while (true) {
      const error = yield* Deferred.await(current.lost).pipe(Effect.flip);
      if (yield* Deferred.isDone(closed)) return;
      if (!isConnectionLost(error) || sessionId === undefined) return yield* fail(error);
      const replacement = yield* reconnect(error);
      if (replacement._tag === "Failure") return yield* fail(replacement.failure);
      const previous = current;
      current = replacement.success;
      reconnecting = false;
      yield* Effect.logInfo("Devin Cloud reconnected", { sessionId });
      yield* Deferred.succeed(available, current.runtime);
      yield* Deferred.succeed(previous.replacement, current.runtime);
    }
  }).pipe(
    Effect.catchDefect((cause) =>
      fail(new AcpErrors.AcpTransportError({ detail: "Devin Cloud reconnection failed.", cause })),
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
  yield* watch.pipe(Effect.forkIn(scope));

  const register = (install: Registration) =>
    Effect.gen(function* () {
      registrations.push(install);
      if (!reconnecting) yield* install(current.runtime, () => true);
    });
  const activate = (
    effect: (runtime: Runtime) => Effect.Effect<AcpSessionRuntimeStartResult, AcpErrors.AcpError>,
  ) =>
    connected.pipe(
      Effect.flatMap(effect),
      Effect.tap((started) =>
        Effect.sync(() => {
          sessionId = started.sessionId;
        }),
      ),
    );
  const drainEvents = Effect.gen(function* () {
    yield* (yield* connected).drainEvents;
    const acknowledge = yield* Deferred.make<void>();
    yield* Queue.offer(events, { _tag: "EventStreamBarrier", acknowledge });
    yield* Effect.raceFirst(Deferred.await(acknowledge), Deferred.await(closed));
  }).pipe(Effect.ignore);
  const terminateProcessGroup = current.runtime.terminateProcessGroup;

  return {
    handleRequestPermission: (handler) =>
      register((runtime) => runtime.handleRequestPermission(handler)),
    handleElicitation: (handler) => register((runtime) => runtime.handleElicitation(handler)),
    handleMcpConnect: (handler) => register((runtime) => runtime.handleMcpConnect(handler)),
    handleMcpMessage: (handler) => register((runtime) => runtime.handleMcpMessage(handler)),
    handleMcpDisconnect: (handler) => register((runtime) => runtime.handleMcpDisconnect(handler)),
    handleMcpNotification: (handler) =>
      register((runtime) => runtime.handleMcpNotification(handler)),
    handleReadTextFile: (handler) => register((runtime) => runtime.handleReadTextFile(handler)),
    handleWriteTextFile: (handler) => register((runtime) => runtime.handleWriteTextFile(handler)),
    handleCreateTerminal: (handler) => register((runtime) => runtime.handleCreateTerminal(handler)),
    handleTerminalOutput: (handler) => register((runtime) => runtime.handleTerminalOutput(handler)),
    handleTerminalWaitForExit: (handler) =>
      register((runtime) => runtime.handleTerminalWaitForExit(handler)),
    handleTerminalKill: (handler) => register((runtime) => runtime.handleTerminalKill(handler)),
    handleTerminalRelease: (handler) =>
      register((runtime) => runtime.handleTerminalRelease(handler)),
    handleSessionUpdate: (handler) =>
      register((runtime, accepts) =>
        runtime.handleSessionUpdate((notification) =>
          accepts(notification) ? handler(notification) : Effect.void,
        ),
      ),
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
    ...(current.runtime.authenticate === undefined
      ? {}
      : {
          authenticate: (methodId: string) =>
            connected.pipe(
              Effect.flatMap((runtime) => runtime.authenticate?.(methodId) ?? Effect.void),
            ),
        }),
    start: () => activate((runtime) => runtime.start()),
    loadSession: (id, activation) => activate((runtime) => runtime.loadSession(id, activation)),
    resumeSession: (id, activation) => activate((runtime) => runtime.resumeSession(id, activation)),
    forkSession: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.forkSession(...args))),
    listSessions: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.listSessions(...args))),
    closeSession: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.closeSession(...args))),
    deleteSession: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.deleteSession(...args))),
    listProviders: connected.pipe(Effect.flatMap((runtime) => runtime.listProviders)),
    setProvider: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.setProvider(...args))),
    disableProvider: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.disableProvider(...args))),
    logout: connected.pipe(Effect.flatMap((runtime) => runtime.logout)),
    getEvents: () => Stream.fromQueue(events),
    drainEvents,
    getModeState: Effect.suspend(() => current.runtime.getModeState),
    getConfigOptions: Effect.suspend(() => current.runtime.getConfigOptions),
    prompt: (payload, promptOptions) =>
      Effect.gen(function* () {
        const runtime = yield* connected;
        const completion = yield* Deferred.make<AcpCompat.PromptResponse, AcpErrors.AcpError>();
        const dispatched = promptOptions?.dispatched ?? (yield* Deferred.make<void>());
        const prompt: PendingPrompt = { completion, dispatched, recovering: false };
        pending.add(prompt);
        const send = (
          runtime: Runtime,
        ): Effect.Effect<AcpCompat.PromptResponse, AcpErrors.AcpError> =>
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
        return yield* Effect.raceFirst(send(runtime), Deferred.await(completion)).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(prompt))),
        );
      }),
    cancel: Effect.gen(function* () {
      for (const prompt of pending) {
        yield* Deferred.succeed(prompt.completion, { stopReason: "cancelled" });
      }
      if (reconnecting) {
        cancelOnReconnect = true;
        return;
      }
      yield* cancelSession(yield* connected);
    }),
    processContainment: current.runtime.processContainment,
    ...(terminateProcessGroup === undefined
      ? {}
      : {
          terminateProcessGroup: Effect.suspend(
            () => current.runtime.terminateProcessGroup ?? Effect.void,
          ),
        }),
    setMode: (mode) => connected.pipe(Effect.flatMap((runtime) => runtime.setMode(mode))),
    setConfigOption: (id, value) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.setConfigOption(id, value))),
    setModel: (model) => connected.pipe(Effect.flatMap((runtime) => runtime.setModel(model))),
    setSessionModel: (...args) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.setSessionModel(...args))),
    request: (method, payload) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.request(method, payload))),
    notify: (method, payload) =>
      connected.pipe(Effect.flatMap((runtime) => runtime.notify(method, payload))),
  } satisfies Runtime;
});
