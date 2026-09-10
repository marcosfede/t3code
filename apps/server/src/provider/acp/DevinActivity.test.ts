import { TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { makeDevinThinkingPreview, makeDevinToolNormalizer } from "./DevinActivity.ts";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

const turnId = TurnId.make("turn-1");

function toolEvent(update: Parameters<typeof parseSessionUpdateEvent>[0]["update"]) {
  const rawPayload = { sessionId: "session-1", update };
  const event = parseSessionUpdateEvent(rawPayload).events.find(
    (event) => event._tag === "ToolCallUpdated",
  );
  if (!event) throw new Error("Expected a tool event");
  return event;
}

describe("Devin tool activity", () => {
  it("retains Cloud command metadata through partial completion and client projection", () => {
    const normalize = makeDevinToolNormalizer();
    const started = toolEvent({
      sessionUpdate: "tool_call",
      toolCallId: "process-1",
      kind: "execute",
      title: "printf hello",
      status: "in_progress",
      _meta: { "cognition.ai/command": "printf hello" },
    });
    const running = normalize(started.toolCall, started.rawPayload);
    expect(running.command).toBe("printf hello");
    const completed = toolEvent({
      sessionUpdate: "tool_call_update",
      toolCallId: "process-1",
      status: "completed",
      rawOutput: "hello",
    });
    const result = normalize(
      mergeToolCallState(started.toolCall, completed.toolCall),
      completed.rawPayload,
    );
    expect(result).toMatchObject({
      status: "completed",
      detail: "printf hello",
      data: { command: "printf hello", rawOutput: "hello" },
    });
    const projected = projectActivityPayload({
      payload: { itemType: "command_execution", data: result.data },
    } as OrchestrationThreadActivity);
    expect(projected.payload).toMatchObject({
      data: { command: "printf hello", rawOutput: { content: "hello" } },
    });
  });

  it("exposes Cloud edit paths and local file_path arguments to existing clients", () => {
    for (const source of [
      { _meta: { "cognition.ai/fileUpdates": [{ file_path: "/workspace/layout.html" }] } },
      { rawInput: { file_path: "/workspace/layout.html" } },
    ]) {
      const event = toolEvent({
        sessionUpdate: "tool_call",
        toolCallId: "edit-1",
        kind: "edit",
        title: "Edited file",
        status: "completed",
        ...source,
      });
      const result = makeDevinToolNormalizer()(event.toolCall, event.rawPayload);
      expect(result.detail).toBe("/workspace/layout.html");
      const projected = projectActivityPayload({
        payload: { itemType: "file_change", data: result.data },
      } as OrchestrationThreadActivity);
      expect(projected.payload).toMatchObject({
        data: { files: [{ path: "/workspace/layout.html" }] },
      });
    }
  });

  it("leaves existing tool detail, browser titles, and malformed metadata alone", () => {
    const normalize = makeDevinToolNormalizer();
    const tool: AcpToolCallState = {
      toolCallId: "browser-1",
      kind: "other",
      title: "Took screenshot",
      detail: "Browser preview",
      data: {},
    };
    expect(normalize(tool, { update: { _meta: { "cognition.ai/command": 42 } } })).toBe(tool);
    expect(normalize(tool, null)).toBe(tool);
  });

  it("prefers explicit Cloud commands over title inference and forgets completed metadata", () => {
    const normalize = makeDevinToolNormalizer();
    const event = toolEvent({
      sessionUpdate: "tool_call",
      toolCallId: "process-1",
      kind: "execute",
      title: "echo `pwd`",
      status: "completed",
      _meta: { "cognition.ai/command": "echo `pwd`" },
    });
    expect(normalize(event.toolCall, event.rawPayload).command).toBe("echo `pwd`");
    const next: AcpToolCallState = { toolCallId: "process-1", kind: "execute", data: {} };
    expect(normalize(next, {})).toBe(next);
  });
});

describe("Devin thinking previews", () => {
  it("batches streaming chunks and flushes the final preview under one activity identity", () => {
    const preview = makeDevinThinkingPreview();
    const first = preview.append("Checking ", turnId, 0);
    expect(first).toMatchObject({
      type: "item.updated",
      turnId,
      payload: { title: "Thinking", status: "inProgress" },
    });
    expect(preview.append("the ", turnId, 100)).toBeUndefined();
    expect(preview.append("layout.", turnId, 499)).toBeUndefined();
    const next = preview.append(" Looks good.", turnId, 500);
    expect(next?.itemId).toBe(first?.itemId);
    expect(preview.append(" Done.", turnId, 501)).toBeUndefined();
    const finished = preview.finish(turnId);
    expect(finished).toMatchObject({
      type: "item.completed",
      itemId: first?.itemId,
      payload: {
        status: "completed",
        data: { rawOutput: { content: "Checking the layout. Looks good. Done." } },
      },
    });
    expect(preview.finish()).toBeUndefined();
  });

  it("bounds long previews and keeps their body in the existing client projection", () => {
    const preview = makeDevinThinkingPreview();
    preview.append("old ".repeat(2000), turnId, 0);
    preview.append("LATEST", turnId, 500);
    const finished = preview.finish()!;
    const projected = projectActivityPayload({
      payload: finished.payload,
    } as OrchestrationThreadActivity);
    expect(JSON.stringify(projected.payload)).toContain("LATEST");
    expect(JSON.stringify(projected.payload).length).toBeLessThan(2300);
  });

  it("does not emit empty previews or reuse identities between phases and turns", () => {
    const preview = makeDevinThinkingPreview();
    expect(preview.append(" \n", turnId, 0)).toBeUndefined();
    expect(preview.finish()).toBeUndefined();
    const first = preview.append("First phase", turnId, 0);
    preview.finish();
    const second = preview.append("Second phase", turnId, 1);
    expect(second?.itemId).not.toBe(first?.itemId);
    const nextTurn = TurnId.make("turn-2");
    const third = preview.append("New turn", nextTurn, 2);
    expect(third?.turnId).toBe(nextTurn);
    expect(preview.finish(turnId)).toBeUndefined();
    expect(preview.finish(nextTurn)?.payload.data).toEqual({
      kind: "think",
      rawOutput: { content: "New turn" },
    });
  });
});
