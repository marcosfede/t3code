import {
  matchesDevinSessionQuery,
  type DevinSessionListInput,
  type DevinSessionListResult,
  type DevinSessionSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const CLOUD_DRIVERS = new Set(["devinCloud", "devinCloudCli"]);
const DEVIN_DRIVERS = new Set(["devin", ...CLOUD_DRIVERS]);

function updatedAtMillis(session: DevinSessionSummary): number {
  const millis = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  return Number.isFinite(millis) ? millis : 0;
}

/** A query searches every session; otherwise only those updated since `updatedAfter` are kept. */
export function selectDevinSessions(
  sessions: ReadonlyArray<DevinSessionSummary>,
  input: DevinSessionListInput,
): Array<DevinSessionSummary> {
  const query = input.query?.trim();
  const since = input.updatedAfter ? Date.parse(input.updatedAfter) : NaN;
  return sessions
    .filter((session) =>
      query
        ? matchesDevinSessionQuery(session, query)
        : !Number.isFinite(since) || updatedAtMillis(session) >= since,
    )
    .toSorted((left, right) => updatedAtMillis(right) - updatedAtMillis(left));
}

/** Lists stored sessions of every enabled, installed Devin provider instance. */
export const makeDevinSessionLister = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const providers = yield* ProviderService;

  return Effect.fn("listDevinSessions")(function* (input: DevinSessionListInput) {
    const instances = (yield* registry.getProviders).filter(
      (instance) => instance.enabled && instance.installed && DEVIN_DRIVERS.has(instance.driver),
    );
    const results = yield* Effect.forEach(
      instances,
      (instance) =>
        providers.listNativeSessions(instance.instanceId).pipe(
          Effect.timeout("45 seconds"),
          Effect.result,
          Effect.map((result) => ({ instance, result })),
        ),
      { concurrency: "unbounded" },
    );
    const sessions: Array<DevinSessionSummary> = [];
    const failures: Array<DevinSessionListResult["failures"][number]> = [];
    for (const { instance, result } of results) {
      if (Result.isFailure(result)) {
        failures.push({ providerInstanceId: instance.instanceId, detail: result.failure.message });
        continue;
      }
      const kind = CLOUD_DRIVERS.has(instance.driver) ? "cloud" : "local";
      for (const session of result.success) {
        sessions.push({ ...session, providerInstanceId: instance.instanceId, kind });
      }
    }
    return {
      sessions: selectDevinSessions(sessions, input),
      failures,
    } satisfies DevinSessionListResult;
  });
});
