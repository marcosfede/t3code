import {
  EventId,
  ThreadId,
  MessageId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  CommandId,
  DevinCloudSessionImportError,
  parseDevinCloudSessionId,
  ProviderDriverKind,
  type DevinCloudSessionImportInput,
  type DevinCloudSessionImportResult,
  type DevinSessionListInput,
  type DevinSessionListResult,
  type DevinSessionSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import type { DevinCloudHistoryMessage } from "../provider/acp/DevinCloudHistory.ts";
import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import type * as ProjectService from "./ProjectService.ts";

const DEVIN_CLOUD_DRIVER = ProviderDriverKind.make("devinCloud");

export interface DevinCloudSessionsDeps {
  readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  readonly projectService: ProjectService.ProjectService["Service"];
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"];
  readonly startup: ServerRuntimeStartup.ServerRuntimeStartup["Service"];
  readonly crypto: Crypto.Crypto;
  readonly eventSink: EventSink.EventSinkV2["Service"];
}

type DevinCloudInstance = ProviderInstance & {
  readonly devinCloudSessions: NonNullable<ProviderInstance["devinCloudSessions"]>;
};

const isDevinCloudInstance = (instance: ProviderInstance): instance is DevinCloudInstance =>
  instance.enabled &&
  instance.driverKind === DEVIN_CLOUD_DRIVER &&
  instance.devinCloudSessions !== undefined;

export const devinCloudThreadId = (instance: ProviderInstance, sessionId: string) =>
  IdAllocator.deriveThreadFromProviderThread({
    driver: instance.driverKind,
    providerInstanceId: instance.instanceId,
    nativeThreadId: sessionId,
  });

/** Lists stored sessions across every enabled Devin Cloud instance, newest first. */
export const listDevinCloudSessions = Effect.fn("DevinCloudSessions.list")(function* (
  deps: {
    readonly providerInstances: Pick<DevinCloudSessionsDeps["providerInstances"], "listInstances">;
  },
  input: DevinSessionListInput,
) {
  const instances = (yield* deps.providerInstances.listInstances)
    .filter(isDevinCloudInstance)
    .filter(
      (instance) =>
        input.cursors === undefined ||
        input.cursors.some((entry) => entry.providerInstanceId === instance.instanceId),
    );
  const updatedAfter = input.updatedAfter ? Date.parse(input.updatedAfter) : undefined;
  const results = yield* Effect.forEach(
    instances,
    (instance) =>
      instance.devinCloudSessions
        .list({
          ...(input.query ? { query: input.query } : {}),
          ...(input.updatedAfter ? { updatedAfter: input.updatedAfter } : {}),
          ...input.cursors?.find((entry) => entry.providerInstanceId === instance.instanceId),
        })
        .pipe(
          Effect.map((page) => ({ instance, ...page })),
          Effect.result,
        ),
    { concurrency: "unbounded" },
  );
  const sessions: Array<DevinSessionSummary> = [];
  const nextCursors: NonNullable<DevinSessionListResult["nextCursors"]>[number][] = [];
  const failures: Array<DevinSessionListResult["failures"][number]> = [];
  for (const [index, result] of results.entries()) {
    const instance = instances[index]!;
    if (Result.isFailure(result)) {
      yield* Effect.logWarning("Could not list Devin Cloud sessions", {
        providerInstanceId: instance.instanceId,
        cause: result.failure,
      });
      failures.push({ providerInstanceId: instance.instanceId, detail: result.failure.detail });
      continue;
    }
    if (result.success.nextCursor)
      nextCursors.push({
        providerInstanceId: instance.instanceId,
        cursor: result.success.nextCursor,
      });
    for (const session of result.success.sessions) {
      const summary = { ...session, providerInstanceId: instance.instanceId };
      if (
        updatedAfter !== undefined &&
        (session.updatedAt === null || Date.parse(session.updatedAt) < updatedAfter)
      ) {
        continue;
      }
      sessions.push({ ...summary, repositories: [...summary.repositories] });
    }
  }
  sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return { sessions, failures, nextCursors } satisfies DevinSessionListResult;
});

const importError = (detail: string) => new DevinCloudSessionImportError({ detail });

const HISTORY_EVENT_PREFIX = "devin-cloud-import:v1";

/**
 * Imported history sits at ordinal 0, before every run's items (runs start at
 * 100), and keeps its order through the zero-padded turn item ids.
 */
function historyEvents(
  threadId: ThreadId,
  index: number,
  entry: DevinCloudHistoryMessage,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(index).padStart(6, "0");
  const messageId = MessageId.make(`${threadId}:devin-cloud:${suffix}`);
  const at = DateTime.makeUnsafe(entry.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: entry.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId,
    runId: null,
    nodeId: null,
    role: entry.role,
    text: entry.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: TurnItemId.make(`${HISTORY_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    entry.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: entry.text,
          attachments: [],
        }
      : { ...common, type: "assistant_message", messageId, text: entry.text, streaming: false };
  return [
    {
      id: EventId.make(`${HISTORY_EVENT_PREFIX}:message:${threadId}:${suffix}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${HISTORY_EVENT_PREFIX}:turn-item:${threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

/**
 * Opens a Devin Cloud session as a T3 thread. The thread id derives from the
 * session id, so importing the same session again returns the existing thread.
 */
export const importDevinCloudSession = Effect.fn("DevinCloudSessions.import")(function* (
  deps: DevinCloudSessionsDeps,
  input: DevinCloudSessionImportInput,
) {
  const sessionId = parseDevinCloudSessionId(input.session);
  if (sessionId === undefined) {
    return yield* importError("Enter a Devin session id or a devin.ai session URL.");
  }
  const project = yield* deps.projectService
    .getById(input.projectId)
    .pipe(Effect.mapError(() => importError("The project is unavailable.")));
  if (Option.isNone(project)) return yield* importError("The project no longer exists.");

  const instances = (yield* deps.providerInstances.listInstances).filter(isDevinCloudInstance);
  const instance =
    input.providerInstanceId === undefined
      ? instances[0]
      : instances.find((candidate) => candidate.instanceId === input.providerInstanceId);
  if (instance === undefined) {
    return yield* importError("Enable a Devin Cloud provider in Settings → Providers first.");
  }

  const threadId = devinCloudThreadId(instance, sessionId);
  const existingShell = deps.threadManagement
    .getThreadShell(threadId)
    .pipe(Effect.mapError(() => importError("Could not check for an existing thread.")));
  const toResult = (
    shell: NonNullable<Effect.Success<typeof existingShell>>,
  ): DevinCloudSessionImportResult =>
    shell.archivedAt === null ? { threadId } : { threadId, archived: true };
  const existing = yield* existingShell;
  if (existing !== null) return toResult(existing);

  if (instance.devinCloudSessions === undefined) {
    return yield* importError("This provider cannot list Devin Cloud sessions.");
  }
  const stored = yield* instance.devinCloudSessions
    .list({ sessionId })
    .pipe(
      Effect.mapError(() =>
        importError("Could not reach Devin Cloud to look up the session. Try again."),
      ),
    );
  const session = stored.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) {
    return yield* importError("No Devin Cloud session with that id was found in this account.");
  }
  const history = yield* instance.devinCloudSessions.history(session).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Could not load a Devin Cloud session history", { sessionId, cause }),
    ),
    Effect.mapError(() => importError("Could not load the Devin session's messages. Try again.")),
  );

  const snapshot = yield* instance.snapshot.getSnapshot;
  const model =
    snapshot.models.find((candidate) => candidate.isDefault)?.slug ??
    snapshot.models[0]?.slug ??
    "default";
  const commandId = CommandId.make(yield* deps.crypto.randomUUIDv4.pipe(Effect.orDie));
  const title = input.title ?? session.title ?? history.title ?? `Devin session ${sessionId}`;
  const launched = yield* Effect.result(
    deps.startup.enqueueCommand(
      deps.threadLaunch.launch({
        commandId,
        threadId,
        projectId: input.projectId,
        title,
        modelSelection: { instanceId: instance.instanceId, model },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        importedNativeThread: {
          ref: { driver: instance.driverKind, nativeId: sessionId, strength: "strong" },
          metadata: { itemIdentityVersion: 2, title },
        },
        createdBy: "user",
        creationSource: "web",
      }),
    ),
  );
  if (Result.isFailure(launched)) {
    const raced = yield* existingShell;
    if (raced !== null) return toResult(raced);
    yield* Effect.logWarning("Could not import a Devin Cloud session", {
      sessionId,
      cause: launched.failure,
    });
    return yield* importError("Could not create a thread for the Devin session.");
  }
  if (history.messages.length > 0) {
    yield* deps.eventSink
      .write({
        events: history.messages.flatMap((entry, index) => historyEvents(threadId, index, entry)),
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not save a Devin Cloud session history", { sessionId, cause }),
        ),
        Effect.mapError(() =>
          importError("The thread was created, but its earlier messages could not be saved."),
        ),
      );
  }
  return { threadId } satisfies DevinCloudSessionImportResult;
});
