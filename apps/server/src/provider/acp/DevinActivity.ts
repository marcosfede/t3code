import { RuntimeItemId, type ItemLifecyclePayload, type TurnId } from "@t3tools/contracts";
import { deriveToolActivityPresentation } from "@t3tools/shared/toolActivity";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { canonicalItemTypeFromAcpToolKind, type AcpToolCallState } from "./AcpRuntimeModel.ts";

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({
    "cognition.ai/command": Schema.optional(Schema.String),
    "cognition.ai/fileUpdates": Schema.optional(
      Schema.Array(Schema.Struct({ file_path: Schema.String })),
    ),
  }),
);
const record = (value: unknown) => (Predicate.isObject(value) ? value : undefined);

export function makeDevinToolNormalizer() {
  const commands = new Map<string, string>();
  return (toolCall: AcpToolCallState, rawPayload: unknown): AcpToolCallState => {
    const update = record(record(rawPayload)?.update);
    const metadata = Option.getOrUndefined(decodeMetadata(update?._meta));
    const command =
      metadata?.["cognition.ai/command"]?.trim() ||
      commands.get(toolCall.toolCallId) ||
      toolCall.command;
    if (command) {
      commands.set(toolCall.toolCallId, command);
      if (commands.size > 256) commands.delete(commands.keys().next().value!);
    }
    if (toolCall.status === "completed" || toolCall.status === "failed") {
      commands.delete(toolCall.toolCallId);
    }
    const filePath = record(toolCall.data.rawInput)?.file_path;
    const paths =
      metadata?.["cognition.ai/fileUpdates"]?.map((file) => file.file_path) ??
      (typeof filePath === "string" ? [filePath] : []);
    const locations = paths.filter((path) => path.trim().length > 0).map((path) => ({ path }));
    if (!command && locations.length === 0) return toolCall;
    const data = {
      ...toolCall.data,
      ...(command ? { command } : {}),
      ...(locations.length > 0
        ? {
            changes: [
              ...(Array.isArray(toolCall.data.changes) ? toolCall.data.changes : []),
              ...locations,
            ],
          }
        : {}),
    };
    const presentation = deriveToolActivityPresentation({
      itemType: canonicalItemTypeFromAcpToolKind(toolCall.kind),
      title: toolCall.title,
      detail: toolCall.detail,
      data,
    });
    return {
      ...toolCall,
      ...(command ? { command } : {}),
      title: presentation.summary,
      ...(presentation.detail ? { detail: presentation.detail } : {}),
      data,
    };
  };
}

type ThinkingUpdate = {
  readonly type: "item.updated" | "item.completed";
  readonly itemId: RuntimeItemId;
  readonly turnId: TurnId;
  readonly payload: ItemLifecyclePayload;
};

export function makeDevinThinkingPreview() {
  let sequence = 0;
  let current:
    | {
        turnId: TurnId;
        itemId: RuntimeItemId;
        text: string;
        emittedText: string;
        emittedAt: number;
      }
    | undefined;

  const snapshot = (completed: boolean): ThinkingUpdate | undefined => {
    if (!current?.text.trim()) return undefined;
    return {
      type: completed ? "item.completed" : "item.updated",
      itemId: current.itemId,
      turnId: current.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        title: "Thinking",
        detail: `Thinking: ${current.text.trim().slice(-160)}`,
        status: completed ? "completed" : "inProgress",
        data: { kind: "think", rawOutput: { content: current.text.trim() } },
      },
    };
  };

  return {
    append(text: string, turnId: TurnId, now: number): ThinkingUpdate | undefined {
      if (current?.turnId !== turnId) {
        current = {
          turnId,
          itemId: RuntimeItemId.make(`devin-thinking:${turnId}:${++sequence}`),
          text: "",
          emittedText: "",
          emittedAt: -Infinity,
        };
      }
      current.text = (current.text + text).slice(-2000);
      if (
        !current.text.trim() ||
        current.text === current.emittedText ||
        now - current.emittedAt < 500
      ) {
        return undefined;
      }
      current.emittedText = current.text;
      current.emittedAt = now;
      return snapshot(false);
    },
    finish(turnId?: TurnId): ThinkingUpdate | undefined {
      if (!current || (turnId !== undefined && current.turnId !== turnId)) return undefined;
      const update = snapshot(true);
      current = undefined;
      return update;
    },
  };
}
