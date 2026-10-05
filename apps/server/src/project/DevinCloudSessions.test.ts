import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { DevinSessionPageInput } from "../provider/acp/DevinCloudAcpSupport.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import { listDevinCloudSessions } from "./DevinCloudSessions.ts";

const instance = (id: string, list: NonNullable<ProviderInstance["devinCloudSessions"]>["list"]) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make("devinCloud"),
    enabled: true,
    devinCloudSessions: { list },
  }) as ProviderInstance;

const deps = (instances: ProviderInstance[]) =>
  ({
    providerInstances: { listInstances: Effect.succeed(instances) },
  }) satisfies Parameters<typeof listDevinCloudSessions>[0];

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
        const result = yield* listDevinCloudSessions(
          deps([
            instance("a", () =>
              Effect.succeed({ sessions: [session("one")], nextCursor: "a-next" }),
            ),
            instance("b", () =>
              Effect.succeed({ sessions: [session("two")], nextCursor: "b-next" }),
            ),
          ]),
          {},
        );
        expect(result.sessions.map((row) => row.sessionId)).toEqual(["one", "two"]);
        expect(result.nextCursors).toEqual([
          { providerInstanceId: "a", cursor: "a-next" },
          { providerInstanceId: "b", cursor: "b-next" },
        ]);
      }),
  );

  it.effect("only advances unfinished providers and keeps server-side content matches", () =>
    Effect.gen(function* () {
      const requests: (DevinSessionPageInput | undefined)[] = [];
      const result = yield* listDevinCloudSessions(
        deps([
          instance("a", () => Effect.die("An exhausted provider must not restart")),
          instance("b", (input) => {
            requests.push(input);
            return Effect.succeed({ sessions: [session("content-match")], nextCursor: null });
          }),
        ]),
        {
          query: "match in a message",
          cursors: [{ providerInstanceId: ProviderInstanceId.make("b"), cursor: "b-next" }],
        },
      );
      expect(requests).toMatchObject([{ query: "match in a message", cursor: "b-next" }]);
      expect(result.sessions).toHaveLength(1);
      expect(result.nextCursors).toEqual([]);
    }),
  );

  it.effect("returns a working provider's page when another provider fails", () =>
    Effect.gen(function* () {
      const result = yield* listDevinCloudSessions(
        deps([
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
        ]),
        {},
      );
      expect(result.sessions.map((row) => row.sessionId)).toEqual(["two"]);
      expect(result.failures).toEqual([{ providerInstanceId: "a", detail: "offline" }]);
      expect(result.nextCursors).toEqual([{ providerInstanceId: "b", cursor: "more" }]);
    }),
  );
});
