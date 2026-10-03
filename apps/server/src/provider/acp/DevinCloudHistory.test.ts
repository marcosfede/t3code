import { describe, expect, it } from "vite-plus/test";
import type * as AcpCompat from "effect-acp/compat";

import { makeDevinCloudHistory } from "./DevinCloudHistory.ts";

const FALLBACK = "2026-09-11T12:00:00.000Z";

const chunk = (
  role: "user" | "agent",
  text: string,
  id: string,
  meta: Record<string, unknown> = {},
): AcpCompat.SessionNotification => ({
  sessionId: "session-1",
  update: {
    sessionUpdate: `${role}_message_chunk`,
    content: { type: "text", text },
    _meta: {
      "cognition.ai/eventId": id,
      "cognition.ai/timestamp": "2026-09-11T10:00:00.000Z",
      ...meta,
    },
  },
});

describe("makeDevinCloudHistory", () => {
  it("keeps roles, message boundaries, timestamps and chunk order", () => {
    const history = makeDevinCloudHistory({ sessionId: "session-1", fallbackTimestamp: FALLBACK });
    history.accept(chunk("user", "Fix it", "u1"));
    history.accept(chunk("agent", "Looking ", "a1"));
    history.accept(chunk("agent", "now", "a1"));
    history.accept(chunk("agent", "Done", "a2"));
    history.accept({ ...chunk("user", "Wrong session", "u2"), sessionId: "other" });
    expect(history.history().messages).toEqual([
      { role: "user", text: "Fix it", createdAt: "2026-09-11T10:00:00.000Z" },
      { role: "assistant", text: "Looking now", createdAt: "2026-09-11T10:00:00.000Z" },
      { role: "assistant", text: "Done", createdAt: "2026-09-11T10:00:00.000Z" },
    ]);
  });

  it("splits messages around tool calls and skips subagent traffic", () => {
    const history = makeDevinCloudHistory({ sessionId: "session-1", fallbackTimestamp: FALLBACK });
    history.accept(chunk("agent", "Before", "a1"));
    history.accept({
      sessionId: "session-1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls" },
    });
    history.accept(chunk("agent", "After", "a1"));
    history.accept(
      chunk("agent", "Subagent says hi", "s1", {
        "cognition.ai/subagent_context": { parentAgentId: "agent-2" },
      }),
    );
    expect(history.history().messages.map((message) => message.text)).toEqual(["Before", "After"]);
  });

  it("shows the user's own words instead of T3's wrapped prompt", () => {
    const history = makeDevinCloudHistory({ sessionId: "session-1", fallbackTimestamp: FALLBACK });
    history.accept({
      sessionId: "session-1",
      update: {
        sessionUpdate: "user_message",
        messageId: "m1",
        content: [
          {
            type: "text",
            text: "<t3_code_instructions>be nice</t3_code_instructions>\n<user_request>\nAdd tests\n</user_request>",
          },
        ],
      },
    });
    expect(history.history().messages).toEqual([
      { role: "user", text: "Add tests", createdAt: FALLBACK },
    ]);
  });

  it("points file citations at the cloud session and records the title", () => {
    const history = makeDevinCloudHistory({
      sessionId: "session-1",
      fallbackTimestamp: FALLBACK,
      sessionUrl: "https://app.devin.ai/sessions/session-1",
    });
    history.accept({
      sessionId: "session-1",
      update: { sessionUpdate: "session_info_update", title: "Fix the build" },
    });
    history.accept(chunk("agent", 'Updated <ref_file file="/workspace/main.ts" />', "a1"));
    const { messages, title } = history.history();
    expect(title).toBe("Fix the build");
    expect(messages[0]?.text).toContain("[main.ts](https://app.devin.ai/sessions/session-1?ts=");
    expect(messages[0]?.text).not.toContain("/workspace/main.ts");
  });
});
