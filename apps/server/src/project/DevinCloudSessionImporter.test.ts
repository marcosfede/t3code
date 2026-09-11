import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  DevinCloudSettings,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSessionStartInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { buildInitialDevinCloudProviderSnapshot } from "../provider/Layers/DevinCloudProvider.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { makeDevinCloudSessionImporter } from "./DevinCloudSessionImporter.ts";

const projectId = ProjectId.make("cloud-import-project");
const instanceId = ProviderInstanceId.make("cloud");
const driver = ProviderDriverKind.make("devinCloud");
const createdAt = "2026-09-11T10:00:00.000Z";
const cloudSettings = Schema.decodeSync(DevinCloudSettings)({ enabled: true });
const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const integrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository)),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-session-import-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeHarness = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory;
  const draft = yield* buildInitialDevinCloudProviderSnapshot(cloudSettings);
  let providers: ReadonlyArray<ServerProvider> = [
    { ...draft, instanceId, driver, continuation: { groupKey: "cloud" } },
  ];
  let fail = false;
  const starts: ProviderSessionStartInput[] = [];
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-cloud-import-project"),
    projectId,
    title: "Project",
    workspaceRoot: process.cwd(),
    defaultModelSelection: null,
    createdAt,
  });
  const importer = yield* makeDevinCloudSessionImporter.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => providers) }),
        Layer.mock(ProviderService)({
          startSession: (threadId, input, hooks) =>
            Effect.gen(function* () {
              starts.push(input);
              if (fail)
                return yield* new ProviderAdapterRequestError({
                  provider: "devinCloud",
                  method: "session/load",
                  detail: "Session not found",
                });
              if (!hooks) return yield* Effect.die("Missing import hook");
              yield* hooks.onHistory({
                title: "Cloud work",
                model: "devin-ultra",
                messages: [
                  { role: "user", text: "Original request", createdAt },
                  { role: "assistant", text: "Original answer", createdAt },
                ],
              });
              const saved = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
              expect(saved.messages.map((message) => message.text)).toEqual([
                "Original request",
                "Original answer",
              ]);
              return {
                provider: driver,
                providerInstanceId: instanceId,
                threadId,
                status: "ready" as const,
                runtimeMode: input.runtimeMode,
                resumeCursor: input.resumeCursor,
                createdAt,
                updatedAt: createdAt,
              };
            }),
        }),
      ),
    ),
  );
  return {
    engine,
    snapshots,
    directory,
    importer,
    starts,
    setFailure: (value: boolean) => {
      fail = value;
    },
    setProviders: (value: ReadonlyArray<ServerProvider>) => {
      providers = value;
    },
    providers,
  };
});

describe("DevinCloudSessionImporter", () => {
  it.effect("imports with a CLI-backed cloud provider and preserves its routing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const cliDriver = ProviderDriverKind.make("devinCloudCli");
      harness.setProviders(
        harness.providers.map((provider) => ({ ...provider, driver: cliDriver })),
      );
      const result = yield* harness.importer({ projectId, session: "cli-session" });
      expect(harness.starts[0]?.provider).toBe(cliDriver);
      expect(Option.getOrThrow(yield* harness.directory.getBinding(result.threadId))).toMatchObject(
        {
          provider: cliDriver,
          providerInstanceId: instanceId,
          resumeCursor: { sessionId: "cli-session", imported: true },
        },
      );
    }).pipe(Effect.provide(integrationLayer)),
  );

  it.effect("does not resurrect a deleted imported thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const result = yield* harness.importer({ projectId, session: "deleted-session" });
      yield* harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-imported-thread"),
        threadId: result.threadId,
      });
      const failure = yield* harness
        .importer({ projectId, session: "deleted-session" })
        .pipe(Effect.flip);
      expect(failure.message).toContain("deleted T3 thread");
      expect(harness.starts).toHaveLength(1);
    }).pipe(Effect.provide(integrationLayer)),
  );

  it.effect("persists history, model and resume binding once for concurrent URL/ID imports", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const results = yield* Effect.all(
        [
          harness.importer({
            projectId,
            session: "https://app.devin.ai/sessions/cloud-session?ts=123",
          }),
          harness.importer({ projectId, session: "cloud-session" }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results[0]).toEqual(results[1]);
      expect(harness.starts).toHaveLength(1);
      expect(harness.starts[0]?.modelSelection).toBeUndefined();
      const threadId = results[0].threadId;
      const thread = Option.getOrThrow(yield* harness.snapshots.getThreadDetailById(threadId));
      expect(thread.title).toBe("Cloud work");
      expect(thread.modelSelection).toEqual({ instanceId, model: "devin-ultra" });
      expect(Option.getOrThrow(yield* harness.directory.getBinding(threadId))).toMatchObject({
        providerInstanceId: instanceId,
        resumeCursor: { schemaVersion: 1, sessionId: "cloud-session", imported: true },
      });
      yield* harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-cloud-import"),
        threadId,
      });
      expect(yield* harness.importer({ projectId, session: "cloud-session" })).toEqual({
        threadId,
      });
      expect(
        Option.getOrThrow(yield* harness.snapshots.getThreadDetailById(threadId)).archivedAt,
      ).toBeNull();
      expect(harness.starts).toHaveLength(1);
    }).pipe(Effect.provide(integrationLayer)),
  );

  it.effect("does not create a thread on a failed load and allows retry", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setFailure(true);
      expect(
        (yield* harness.importer({ projectId, session: "missing-session" }).pipe(Effect.flip))
          .message,
      ).toContain("Session not found");
      expect(yield* harness.directory.listBindings()).toEqual([]);
      harness.setFailure(false);
      const result = yield* harness.importer({ projectId, session: "missing-session" });
      expect(Option.isSome(yield* harness.snapshots.getThreadDetailById(result.threadId))).toBe(
        true,
      );
    }).pipe(Effect.provide(integrationLayer)),
  );

  it.effect("requires an explicit provider when cloud accounts are ambiguous", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.setProviders([
        ...harness.providers,
        { ...harness.providers[0]!, instanceId: ProviderInstanceId.make("other-cloud") },
      ]);
      expect(
        (yield* harness.importer({ projectId, session: "cloud-session" }).pipe(Effect.flip))
          .message,
      ).toContain("Choose which");
      expect(harness.starts).toEqual([]);
      yield* harness.importer({
        projectId,
        session: "cloud-session",
        providerInstanceId: instanceId,
      });
      expect(harness.starts[0]?.providerInstanceId).toBe(instanceId);
    }).pipe(Effect.provide(integrationLayer)),
  );

  it.effect("rejects non-Devin URLs and unavailable projects before starting a session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness
        .importer({ projectId, session: "https://example.com/sessions/cloud-session" })
        .pipe(Effect.flip);
      yield* harness
        .importer({ projectId: ProjectId.make("missing-project"), session: "cloud-session" })
        .pipe(Effect.flip);
      expect(harness.starts).toEqual([]);
      expect(yield* harness.directory.listBindings()).toEqual([]);
    }).pipe(Effect.provide(integrationLayer)),
  );
});
