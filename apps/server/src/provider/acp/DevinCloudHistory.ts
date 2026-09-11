import type * as AcpSchema from "effect-acp/schema";
import * as DateTime from "effect/DateTime";

import type { ProviderSessionHistory } from "../Services/ProviderAdapter.ts";
import { assistantContentText } from "./AcpRuntimeModel.ts";
import { makeDevinReferenceNormalizer } from "./DevinReferences.ts";

export function devinCloudSessionState(
  meta: Readonly<Record<string, unknown>>,
): "running" | "ready" | "error" | undefined {
  switch (meta["cognition.ai/statusEnum"]) {
    case "working":
    case "running":
      return "running";
    case "finished":
    case "blocked":
      return "ready";
    case "crashed":
      return "error";
    default:
      return undefined;
  }
}

export function makeDevinCloudHistory(sessionId: string, fallbackTimestamp: string) {
  const messages: Array<ProviderSessionHistory["messages"][number]> = [];
  let previousId: unknown;
  let boundary = true;
  let title: string | undefined;
  let size = 0;
  let overflow = false;
  return {
    accept(notification: AcpSchema.SessionNotification) {
      if (notification.sessionId !== sessionId) return;
      const update = notification.update;
      if (update.sessionUpdate === "session_info_update" && update.title) title = update.title;
      if (
        update.sessionUpdate !== "user_message_chunk" &&
        update.sessionUpdate !== "agent_message_chunk"
      ) {
        boundary = true;
        return;
      }
      const text = assistantContentText(update.content);
      if (!text) return;
      size += text.length;
      if (size > 16 * 1024 * 1024 || messages.length >= 20_000) {
        overflow = true;
        return;
      }
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const id = update._meta?.["cognition.ai/eventId"];
      const previous = messages.at(-1);
      if (!boundary && previous?.role === role && id === previousId) {
        messages[messages.length - 1] = { ...previous, text: previous.text + text };
      } else {
        const timestamp = update._meta?.["cognition.ai/timestamp"];
        const millis =
          typeof timestamp === "number"
            ? timestamp
            : typeof timestamp === "string"
              ? Date.parse(timestamp)
              : NaN;
        const createdAt =
          Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
            ? DateTime.formatIso(DateTime.makeUnsafe(millis))
            : fallbackTimestamp;
        messages.push({ role, text, createdAt });
      }
      previousId = id;
      boundary = false;
    },
    messages: (sessionMetadata?: unknown) =>
      messages
        .filter((message) => message.text.trim().length > 0)
        .map((message) => {
          if (message.role !== "assistant") return message;
          const normalize = makeDevinReferenceNormalizer({ cloud: true, sessionMetadata });
          const events = [
            ...normalize({
              _tag: "ContentDelta",
              text: message.text,
              rawPayload: { update: { _meta: { "cognition.ai/timestamp": message.createdAt } } },
            }),
            ...normalize({ _tag: "AssistantItemCompleted", itemId: "history" }),
          ];
          return {
            ...message,
            text: events
              .flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : []))
              .join(""),
          };
        }),
    title: () => title,
    overflowed: () => overflow,
  };
}
