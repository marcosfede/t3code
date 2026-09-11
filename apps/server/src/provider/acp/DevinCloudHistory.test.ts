import { describe, expect, it } from "vite-plus/test";
import type * as AcpSchema from "effect-acp/schema";

import { makeDevinCloudHistory } from "./DevinCloudHistory.ts";

const message = (
  role: "user" | "agent",
  text: string,
  id: string,
): AcpSchema.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: `${role}_message_chunk`,
    content: { type: "text", text },
    _meta: { "cognition.ai/eventId": id, "cognition.ai/timestamp": "2026-09-11T10:00:00.000Z" },
  },
});

describe("Devin Cloud history", () => {
  it("keeps cloud file citations pointing at the cloud session", () => {
    const history = makeDevinCloudHistory("session-1", "2026-09-11T12:00:00.000Z");
    history.accept(message("agent", 'Updated <ref_file file="/workspace/main.ts" />', "a1"));
    const text = history.messages({
      "cognition.ai/url": "https://app.devin.ai/sessions/session-1",
    })[0]?.text;
    expect(text).toContain("[main.ts](https://app.devin.ai/sessions/session-1?ts=");
    expect(text).not.toContain("/workspace/main.ts");
  });

  it("preserves roles, message boundaries, timestamps and chunk order", () => {
    const history = makeDevinCloudHistory("session-1", "2026-09-11T12:00:00.000Z");
    history.accept(message("user", "Fix it", "u1"));
    history.accept(message("agent", "Looking ", "a1"));
    history.accept(message("agent", "now", "a1"));
    history.accept(message("agent", "Done", "a2"));
    history.accept({ ...message("user", "Wrong session", "u2"), sessionId: "other" });
    expect(history.messages()).toEqual([
      { role: "user", text: "Fix it", createdAt: "2026-09-11T10:00:00.000Z" },
      { role: "assistant", text: "Looking now", createdAt: "2026-09-11T10:00:00.000Z" },
      { role: "assistant", text: "Done", createdAt: "2026-09-11T10:00:00.000Z" },
    ]);
  });

  it("preserves attachment links and uses a fallback timestamp", () => {
    const history = makeDevinCloudHistory("session-1", "2026-09-11T12:00:00.000Z");
    history.accept({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "resource_link", name: "report.md", uri: "https://example.com/report.md" },
      },
    });
    expect(history.messages()[0]).toEqual({
      role: "assistant",
      text: "\n\n[report.md](https://example.com/report.md)\n\n",
      createdAt: "2026-09-11T12:00:00.000Z",
    });
  });
});
