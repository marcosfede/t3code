import { ProviderInstanceId, type DevinSessionSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { selectDevinSessions } from "./DevinSessionLister.ts";

function session(
  sessionId: string,
  updatedAt: string | null,
  overrides: Partial<DevinSessionSummary> = {},
): DevinSessionSummary {
  return {
    providerInstanceId: ProviderInstanceId.make("devinCloud"),
    kind: "cloud",
    sessionId,
    title: null,
    cwd: null,
    updatedAt,
    url: null,
    status: null,
    repositories: [],
    excerpt: null,
    ...overrides,
  };
}

describe("selectDevinSessions", () => {
  const sessions = [
    session("devin-old", "2026-01-01T00:00:00.000Z", {
      title: "Fix org selector",
      repositories: ["acme/web"],
    }),
    session("devin-new", "2026-03-10T00:00:00.000Z"),
    session("devin-edge", "2026-03-03T00:00:00.000Z"),
    session("devin-undated", null),
  ];

  it("keeps sessions updated since the cutoff, newest first", () => {
    expect(
      selectDevinSessions(sessions, { updatedAfter: "2026-03-03T00:00:00.000Z" }).map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["devin-new", "devin-edge"]);
  });

  it("searches every session regardless of age, case-insensitively", () => {
    const search = (query: string) =>
      selectDevinSessions(sessions, { query, updatedAfter: "2026-03-03T00:00:00.000Z" }).map(
        (entry) => entry.sessionId,
      );
    expect(search("ORG")).toEqual(["devin-old"]);
    expect(search("acme/")).toEqual(["devin-old"]);
    expect(search("devin-ne")).toEqual(["devin-new"]);
    expect(search("billing")).toEqual([]);
  });

  it("returns everything newest first without a cutoff or query", () => {
    expect(selectDevinSessions(sessions, {}).map((entry) => entry.sessionId)).toEqual([
      "devin-new",
      "devin-edge",
      "devin-old",
      "devin-undated",
    ]);
  });
});
