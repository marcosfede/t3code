import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { listDevinAcpSessions } from "./DevinSessionList.ts";

describe("listDevinAcpSessions", () => {
  it.effect("follows cursors, reads Devin metadata and skips archived sessions", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const pages: Record<string, unknown> = {
        first: {
          sessions: [
            {
              sessionId: "devin-cloud-1",
              cwd: "/home/ubuntu",
              title: "Fix org selector",
              updatedAt: "2026-09-24T20:11:45Z",
              _meta: {
                "cognition.ai/url": "https://app.devin.ai/sessions/cloud-1",
                "cognition.ai/statusEnum": "finished",
                "cognition.ai/sessionRepos": [{ id: "a/b", name: "a/b" }, { id: 1 }],
                "cognition.ai/messageExcerpts": "Fix the selector",
              },
            },
            {
              sessionId: "devin-archived",
              cwd: "/home/ubuntu",
              _meta: { "cognition.ai/isArchived": true },
            },
          ],
          nextCursor: "page-2",
        },
        "page-2": {
          sessions: [{ sessionId: "shrub-griffin", cwd: "/tmp/project", title: null }],
          nextCursor: null,
        },
      };
      const sessions = yield* listDevinAcpSessions({
        initialize: () => Effect.succeed({ protocolVersion: 1 }),
        request: (method, payload) =>
          Effect.sync(() => {
            requests.push({ method, payload });
            const cursor =
              typeof payload === "object" && payload !== null && "cursor" in payload
                ? String(payload.cursor)
                : "first";
            return pages[cursor];
          }),
      });
      expect(requests).toEqual([
        { method: "session/list", payload: {} },
        { method: "session/list", payload: { cursor: "page-2" } },
      ]);
      expect(sessions).toEqual([
        {
          sessionId: "devin-cloud-1",
          title: "Fix org selector",
          cwd: "/home/ubuntu",
          updatedAt: "2026-09-24T20:11:45Z",
          url: "https://app.devin.ai/sessions/cloud-1",
          status: "finished",
          repositories: ["a/b"],
          excerpt: "Fix the selector",
        },
        {
          sessionId: "shrub-griffin",
          title: null,
          cwd: "/tmp/project",
          updatedAt: null,
          url: null,
          status: null,
          repositories: [],
          excerpt: null,
        },
      ]);
    }),
  );
});
