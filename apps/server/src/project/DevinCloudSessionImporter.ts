import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DevinCloudSessionImportError,
  MessageId,
  ThreadId,
  parseDevinCloudSessionId,
  type DevinCloudSessionImportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

const isImportError = Schema.is(DevinCloudSessionImportError);

export const makeDevinCloudSessionImporter = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry;
  const providers = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const lock = yield* Semaphore.make(1);
  const crypto = yield* Crypto.Crypto;
  const commandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make));

  return Effect.fn("importDevinCloudSession")(
    function* (input: DevinCloudSessionImportInput) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const sessionId = parseDevinCloudSessionId(input.session);
          if (!sessionId)
            return yield* new DevinCloudSessionImportError({
              detail: "Paste a Devin session URL or session ID.",
            });
          const candidates = (yield* registry.getProviders).filter(
            (instance) =>
              (instance.driver === "devinCloud" || instance.driver === "devinCloudCli") &&
              instance.enabled &&
              (input.providerInstanceId === undefined ||
                input.providerInstanceId === instance.instanceId),
          );
          const instance = candidates[0];
          if (!instance)
            return yield* new DevinCloudSessionImportError({
              detail: "Enable a Devin Cloud provider in Settings → Providers first.",
            });
          if (candidates.length > 1)
            return yield* new DevinCloudSessionImportError({
              detail: "Choose which Devin Cloud provider to use.",
            });
          const project = yield* snapshots.getProjectShellById(input.projectId);
          if (Option.isNone(project))
            return yield* new DevinCloudSessionImportError({
              detail: "The selected project no longer exists.",
            });
          const bindings = yield* directory.listBindings();
          const binding = bindings.find(
            (entry) =>
              entry.providerInstanceId === instance.instanceId &&
              Predicate.isObject(entry.resumeCursor) &&
              entry.resumeCursor.sessionId === sessionId,
          );
          const threadId =
            binding?.threadId ?? ThreadId.make(`import:${instance.instanceId}:${sessionId}`);
          const row = yield* snapshots.getThreadLifecycleById(threadId);
          if (Option.isSome(row)) {
            if (row.value.deletedAt !== null) {
              return yield* new DevinCloudSessionImportError({
                detail: "This session belongs to a deleted T3 thread.",
              });
            }
            if (row.value.archivedAt !== null) {
              yield* engine.dispatch({
                type: "thread.unarchive",
                commandId: yield* commandId,
                threadId,
              });
              return { threadId };
            }
          }
          const existing = yield* snapshots.getThreadDetailById(threadId);
          if (Option.isSome(existing)) {
            if (existing.value.messages.length > 0 || existing.value.session !== null)
              return { threadId };
            if (existing.value.projectId !== input.projectId) {
              return yield* new DevinCloudSessionImportError({
                detail: "This session is already being imported into another project.",
              });
            }
          }
          const cwd = project.value.workspaceRoot;
          const resumeCursor = { schemaVersion: 1, sessionId, imported: true };
          yield* providers.startSession(
            threadId,
            {
              threadId,
              providerInstanceId: instance.instanceId,
              provider: instance.driver,
              cwd,
              resumeCursor,
              runtimeMode: DEFAULT_RUNTIME_MODE,
            },
            {
              onHistory: (history) =>
                Effect.gen(function* () {
                  const currentProject = yield* snapshots.getProjectShellById(input.projectId);
                  if (Option.isNone(currentProject) || currentProject.value.workspaceRoot !== cwd) {
                    return yield* new DevinCloudSessionImportError({
                      detail: "The project changed while importing. Try again.",
                    });
                  }
                  const model = history.model ?? "devin-2-5";
                  const modelSelection = { instanceId: instance.instanceId, model };
                  yield* directory.upsert(
                    {
                      threadId,
                      provider: instance.driver,
                      providerInstanceId: instance.instanceId,
                      status: "stopped",
                      runtimeMode: DEFAULT_RUNTIME_MODE,
                      resumeCursor,
                      runtimePayload: { cwd, modelSelection },
                    },
                    { onConflict: "ignore" },
                  );
                  if (Option.isNone(existing)) {
                    yield* engine.dispatch({
                      type: "thread.create",
                      commandId: yield* commandId,
                      threadId,
                      projectId: input.projectId,
                      title: (
                        history.title?.trim() ||
                        history.messages.find((message) => message.role === "user")?.text.trim() ||
                        "Devin Cloud session"
                      ).slice(0, 200),
                      modelSelection,
                      runtimeMode: DEFAULT_RUNTIME_MODE,
                      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                      branch: null,
                      worktreePath: null,
                      createdAt: DateTime.formatIso(yield* DateTime.now),
                      historyImport: true,
                    });
                  }
                  if (history.messages.length > 0) {
                    yield* engine.dispatch({
                      type: "thread.history.import",
                      commandId: yield* commandId,
                      threadId,
                      messages: history.messages.map((message, index) => ({
                        ...message,
                        messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
                      })),
                    });
                  }
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: instance.driver,
                        method: "importSession",
                        detail: cause.message,
                        cause,
                      }),
                  ),
                  Effect.uninterruptible,
                ),
            },
          );
          return { threadId };
        }),
      );
    },
    Effect.mapError((cause) =>
      isImportError(cause) ? cause : new DevinCloudSessionImportError({ detail: cause.message }),
    ),
  );
});
