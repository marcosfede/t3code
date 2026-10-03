import { describe, expect, it } from "@effect/vitest";
import type * as AcpCompat from "effect-acp/compat";

import { normalizeDevinCloudUserMessage, unwrapT3PromptText } from "./DevinReferences.ts";

const wrapped =
  "<t3_code_instructions>\nT3 Code interaction mode: Default\n</t3_code_instructions>\n\n<user_request>\nanswer 2+2\n</user_request>";

const notification = (update: AcpCompat.SessionUpdate): AcpCompat.SessionNotification => ({
  sessionId: "devin-1",
  update,
});

describe("unwrapT3PromptText", () => {
  it("returns the user request from a wrapped prompt", () => {
    expect(unwrapT3PromptText(wrapped)).toBe("answer 2+2");
  });

  it("drops runtime sections without a request wrapper", () => {
    expect(unwrapT3PromptText("hi\n<runtime_info>\ncwd: /x\n</runtime_info>")).toBe("hi");
  });

  it("leaves ordinary text, including whitespace, unchanged", () => {
    expect(unwrapT3PromptText(" plain chunk ")).toBe(" plain chunk ");
  });
});

describe("normalizeDevinCloudUserMessage", () => {
  it("turns a whole user message echo into an unwrapped chunk", () => {
    const result = normalizeDevinCloudUserMessage(
      notification({
        sessionUpdate: "user_message",
        messageId: "m1",
        content: [
          { type: "text", text: wrapped },
          { type: "text", text: "<pull_request_linking>\nlink PRs\n</pull_request_linking>" },
        ],
      }),
    );
    expect(result.update).toEqual({
      sessionUpdate: "user_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "answer 2+2" },
    });
  });

  it("unwraps replayed user chunks", () => {
    const result = normalizeDevinCloudUserMessage(
      notification({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: wrapped },
      }),
    );
    expect(result.update).toMatchObject({ content: { type: "text", text: "answer 2+2" } });
  });

  it("passes agent messages through", () => {
    const input = notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: wrapped },
    });
    expect(normalizeDevinCloudUserMessage(input)).toBe(input);
  });
});
