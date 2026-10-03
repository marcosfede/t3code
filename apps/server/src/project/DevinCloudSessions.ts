import {
  CommandId,
  DevinCloudSessionImportError,
  matchesDevinSessionQuery,
  parseDevinCloudSessionId,
  ProviderDriverKind,
  type DevinCloudSessionImportInput,
  type DevinCloudSessionImportResult,
  type DevinSessionListInput,
  type DevinSessionListResult,
  type DevinSessionSummary,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
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
  deps: Pick<DevinCloudSessionsDeps, "providerInstances">,
  input: DevinSessionListInput,
) {
  const instances = (yield* deps.providerInstances.listInstances).filter(isDevinCloudInstance);
  const updatedAfter = input.updatedAfter ? Date.parse(input.updatedAfter) : undefined;
  const results = yield* Effect.forEach(
    instances,
    (instance) =>
      instance.devinCloudSessions.list.pipe(
        Effect.map((sessions) => ({ instance, sessions })),
        Effect.result,
      ),
    { concurrency: "unbounded" },
  );
  const sessions: Array<DevinSessionSummary> = [];
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
    for (const session of result.success.sessions) {
      const summary = { ...session, providerInstanceId: instance.instanceId };
      if (input.query && !matchesDevinSessionQuery(summary, input.query)) continue;
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
  return { sessions, failures } satisfies DevinSessionListResult;
});

const importError = (detail: string) => new DevinCloudSessionImportError({ detail });

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

  const snapshot = yield* instance.snapshot.getSnapshot;
  const model =
    snapshot.models.find((candidate) => candidate.isDefault)?.slug ??
    snapshot.models[0]?.slug ??
    "default";
  const commandId = CommandId.make(yield* deps.crypto.randomUUIDv4.pipe(Effect.orDie));
  const title = input.title ?? `Devin session ${sessionId}`;
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
  return { threadId } satisfies DevinCloudSessionImportResult;
});
