import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { DevinCloudSessionsAccess } from "../provider/Drivers/DevinCloudDriver.ts";
import type { DevinSessionPageInput } from "../provider/acp/DevinCloudAcpSupport.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as DevinCloudSessions from "./DevinCloudSessions.ts";
import * as ProjectService from "./ProjectService.ts";

const instance = (id: string, list: DevinCloudSessionsAccess["list"]) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make("devinCloud"),
    enabled: true,
    devinCloudSessions: { list },
  }) as unknown as ProviderInstance;

// Listing only reads the provider registry; the import-only services stay unimplemented.
const unused = <Service>(): Service => ({}) as Service;
const list = (
  instances: ProviderInstance[],
  input: Parameters<DevinCloudSessions.DevinCloudSessions["Service"]["list"]>[0],
) =>
  DevinCloudSessions.DevinCloudSessions.use((sessions) => sessions.list(input)).pipe(
    Effect.provide(
      DevinCloudSessions.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
              ...unused<ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]>(),
              listInstances: Effect.succeed(instances),
            }),
            Layer.succeed(ProjectService.ProjectService, unused()),
            Layer.succeed(ThreadManagementService.ThreadManagementService, unused()),
            Layer.succeed(ThreadLaunchService.ThreadLaunchService, unused()),
            Layer.succeed(ServerRuntimeStartup.ServerRuntimeStartup, unused()),
            Layer.succeed(Crypto.Crypto, unused()),
            Layer.succeed(EventSink.EventSinkV2, unused()),
          ),
        ),
      ),
    ),
  );

const session = (sessionId: string) => ({
  sessionId,
  title: "Old session",
  updatedAt: "2020-01-01T00:00:00Z",
  cwd: null,
  url: null,
  status: null,
  repositories: [],
  excerpt: null,
});

describe("Devin Cloud session pages", () => {
  it.effect(
    "lists older sessions from every provider and preserves their independent cursors",
    () =>
      Effect.gen(function* () {
        const result = yield* list(
          [
            instance("a", () =>
              Effect.succeed({ sessions: [session("one")], nextCursor: "a-next" }),
            ),
            instance("b", () =>
              Effect.succeed({ sessions: [session("two")], nextCursor: "b-next" }),
            ),
          ],
          {},
        );
        expect(result.sessions.map((row) => row.sessionId)).toEqual(["one", "two"]);
        expect(result.nextCursors).toEqual([
          { providerInstanceId: "a", cursor: "a-next" },
          { providerInstanceId: "b", cursor: "b-next" },
        ]);
      }),
  );

  it.effect("only advances unfinished providers and forwards search and filters", () =>
    Effect.gen(function* () {
      const requests: (DevinSessionPageInput | undefined)[] = [];
      const result = yield* list(
        [
          instance("a", () => Effect.die("An exhausted provider must not restart")),
          instance("b", (input) => {
            requests.push(input);
            return Effect.succeed({ sessions: [session("content-match")], nextCursor: null });
          }),
        ],
        {
          query: "match in a message",
          filters: { status: ["running"], origin: ["slack"] },
          cursors: [{ providerInstanceId: ProviderInstanceId.make("b"), cursor: "b-next" }],
        },
      );
      expect(requests).toEqual([
        {
          query: "match in a message",
          filters: { status: ["running"], origin: ["slack"] },
          providerInstanceId: "b",
          cursor: "b-next",
        },
      ]);
      expect(result.sessions).toHaveLength(1);
      expect(result.nextCursors).toEqual([]);
    }),
  );

  it.effect("returns a working provider's page when another provider fails", () =>
    Effect.gen(function* () {
      const result = yield* list(
        [
          instance("a", () =>
            Effect.fail(
              new ProviderDriverError({
                driver: ProviderDriverKind.make("devinCloud"),
                instanceId: ProviderInstanceId.make("a"),
                detail: "offline",
              }),
            ),
          ),
          instance("b", () => Effect.succeed({ sessions: [session("two")], nextCursor: "more" })),
        ],
        {},
      );
      expect(result.sessions.map((row) => row.sessionId)).toEqual(["two"]);
      expect(result.failures).toEqual([{ providerInstanceId: "a", detail: "offline" }]);
      expect(result.nextCursors).toEqual([{ providerInstanceId: "b", cursor: "more" }]);
    }),
  );
});
