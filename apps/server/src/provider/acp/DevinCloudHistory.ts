import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type * as AcpCompat from "effect-acp/compat";

import { acpContentBlockDisplayText } from "./AcpRuntimeModel.ts";
import {
  makeDevinCloudReferenceRewriter,
  normalizeDevinCloudUserMessage,
} from "./DevinReferences.ts";

const MAX_HISTORY_TEXT_LENGTH = 16 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 20_000;

export interface DevinCloudHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface DevinCloudSessionHistory {
  readonly messages: ReadonlyArray<DevinCloudHistoryMessage>;
  readonly title: string | null;
  readonly truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function updateMeta(update: AcpCompat.SessionNotification["update"]) {
  return record("_meta" in update ? update._meta : undefined);
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  return Option.match(DateTime.make(value), {
    onNone: () => fallback,
    onSome: DateTime.formatIso,
  });
}

/**
 * Rebuilds a Cloud session's transcript from the events `session/load` replays.
 * Subagent traffic and tool calls are left out; only the root conversation is kept.
 */
export function makeDevinCloudHistory(input: {
  readonly sessionId: string;
  readonly fallbackTimestamp: string;
  readonly sessionUrl?: string | null;
}) {
  const rewriteReferences = makeDevinCloudReferenceRewriter();
  if (input.sessionUrl) {
    rewriteReferences({
      sessionId: input.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { "cognition.ai/url": input.sessionUrl },
      },
    });
  }
  const messages: Array<{ role: "user" | "assistant"; text: string; createdAt: string }> = [];
  let previousId: unknown;
  let boundary = true;
  let title: string | null = null;
  let size = 0;
  let truncated = false;

  return {
    accept(raw: AcpCompat.SessionNotification) {
      if (raw.sessionId !== input.sessionId) return;
      const parentAgentId = record(
        updateMeta(raw.update)?.["cognition.ai/subagent_context"],
      )?.parentAgentId;
      if (typeof parentAgentId === "string" && parentAgentId !== "root") return;
      const update = rewriteReferences(normalizeDevinCloudUserMessage(raw)).update;
      let role: "user" | "assistant";
      let text: string;
      switch (update.sessionUpdate) {
        case "user_message_chunk":
        case "agent_message_chunk":
          role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
          text = acpContentBlockDisplayText(update.content) ?? "";
          break;
        case "agent_message":
          role = "assistant";
          text = (update.content ?? [])
            .map((block) => acpContentBlockDisplayText(block) ?? "")
            .join("");
          break;
        case "session_info_update":
          if (update.title?.trim()) title = update.title.trim();
          boundary = true;
          return;
        default:
          boundary = true;
          return;
      }
      if (!text || truncated) return;
      size += text.length;
      if (size > MAX_HISTORY_TEXT_LENGTH || messages.length >= MAX_HISTORY_MESSAGES) {
        truncated = true;
        return;
      }
      const meta = updateMeta(update);
      const id =
        meta?.["cognition.ai/streamingMessageId"] ??
        meta?.["cognition.ai/eventId"] ??
        ("messageId" in update ? update.messageId : undefined);
      const previous = messages.at(-1);
      if (!boundary && previous?.role === role && id === previousId) {
        previous.text += text;
      } else {
        messages.push({
          role,
          text,
          createdAt: isoTimestamp(meta?.["cognition.ai/timestamp"], input.fallbackTimestamp),
        });
      }
      previousId = id;
      boundary = update.sessionUpdate === "agent_message";
    },
    history(): DevinCloudSessionHistory {
      return {
        messages: messages
          .filter((message) => message.text.trim().length > 0)
          .map((message) => ({ ...message })),
        title,
        truncated,
      };
    },
  };
}
