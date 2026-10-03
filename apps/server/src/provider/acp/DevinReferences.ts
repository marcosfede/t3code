import type * as EffectAcpSchema from "effect-acp/compat";

const REFERENCE_PREFIXES = ["<ref_file", "<ref_snippet"];
const MAX_PENDING_REFERENCE = 8192;
const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionUrlFromMetadata(meta: unknown): string | undefined {
  const value = record(meta)?.["cognition.ai/url"];
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    return undefined;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Renders a Devin `<ref_file/>` or `<ref_snippet/>` citation as a markdown link. */
export function devinReferenceLink(tag: string, cloudUrl: string | null | undefined): string {
  const match = /^<ref_(file|snippet)\s+((?:[^<>"']|"[^"]*"|'[^']*')*)\/\s*>$/.exec(tag);
  if (!match) return tag;
  const attributes = new Map(
    Array.from(match[2]!.matchAll(/([\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g), (attribute) => [
      attribute[1]!,
      (attribute[2] ?? attribute[3]!).replace(
        /&(?:amp|quot|apos|lt|gt);/g,
        (entity) => XML_ENTITIES[entity]!,
      ),
    ]),
  );
  const file = attributes.get("file");
  if (!file || /[\r\n]/.test(file) || !/^(?:\/|\.{1,2}\/|[A-Za-z]:[\\/])/.test(file)) {
    return tag;
  }
  const lines = attributes.get("lines");
  const position = lines && /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(lines);
  if (match[1] === "snippet" && !position) return tag;
  const path = file.replaceAll("\\", "/");
  const name = path.split("/").at(-1) || path;
  const label = `${name}${position ? `:${lines}` : ""}`.replace(/[\\`*_[\]<>]/g, "\\$&");
  if (cloudUrl === null) return label;
  if (cloudUrl !== undefined) {
    const href = cloudUrl.replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
    return `[${label}](${href} "Open citation in Devin")`;
  }
  const href = path
    .split("/")
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `[${label}](${href}${position ? `#L${position[1]}` : ""})`;
}

interface ReferenceState {
  sessionUrl: string | undefined;
  messageTimestamp: number | undefined;
  pending: string;
  codeDelimiter: string;
}

/**
 * Rewrites Devin Cloud citations in assistant text chunks. A citation split
 * across chunks is held back until its closing `>` arrives; code spans and
 * fences are left untouched. Cloud files live on the remote machine, so links
 * open the Devin session at the message instead of a local path.
 */
export function makeDevinCloudReferenceRewriter() {
  const states = new Map<string, ReferenceState>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification => {
    const state = states.get(notification.sessionId) ?? {
      sessionUrl: undefined,
      messageTimestamp: undefined,
      pending: "",
      codeDelimiter: "",
    };
    states.set(notification.sessionId, state);
    const update = notification.update;
    const updateMeta = record("_meta" in update ? update._meta : undefined);
    state.sessionUrl =
      sessionUrlFromMetadata(record(notification._meta)?.["cognition.ai/session"]) ??
      sessionUrlFromMetadata(updateMeta?.["cognition.ai/session"]) ??
      (update.sessionUpdate === "session_info_update"
        ? sessionUrlFromMetadata(updateMeta)
        : undefined) ??
      state.sessionUrl;
    if (update.sessionUpdate === "agent_message" && update.content) {
      const cloudUrl = state.sessionUrl ?? null;
      const content = update.content.map((block) =>
        block.type === "text"
          ? {
              ...block,
              text: rewriteReferences(
                { ...state, pending: "", codeDelimiter: "" },
                block.text,
                cloudUrl,
              ),
            }
          : block,
      );
      return { ...notification, update: { ...update, content } };
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      if (update.sessionUpdate !== "agent_message_chunk") {
        state.pending = "";
        state.codeDelimiter = "";
        state.messageTimestamp = undefined;
      }
      return notification;
    }
    const value = updateMeta?.["cognition.ai/timestamp"];
    const timestamp = typeof value === "string" ? Date.parse(value) : value;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
      state.messageTimestamp = timestamp;
    }
    const url = state.sessionUrl ? new URL(state.sessionUrl) : undefined;
    if (url && state.messageTimestamp !== undefined) {
      url.searchParams.set("ts", String(state.messageTimestamp));
    }
    const text = rewriteReferences(state, update.content.text, url?.toString() ?? null);
    return { ...notification, update: { ...update, content: { ...update.content, text } } };
  };
}

function rewriteReferences(state: ReferenceState, chunk: string, cloudUrl: string | null) {
  const input = state.pending + chunk;
  state.pending = "";
  let output = "";
  let offset = 0;
  const tokens = /\\[\s\S]?|`+|~+|</g;
  for (let token = tokens.exec(input); token; token = tokens.exec(input)) {
    output += input.slice(offset, token.index);
    offset = tokens.lastIndex;
    const value = token[0];
    if (value !== "<") {
      if (value === state.codeDelimiter) state.codeDelimiter = "";
      else if (
        !state.codeDelimiter &&
        (value.startsWith("`") || (value.length >= 3 && value.startsWith("~")))
      ) {
        state.codeDelimiter = value;
      }
      output += value;
      continue;
    }
    const remaining = input.slice(token.index);
    if (
      !state.codeDelimiter &&
      REFERENCE_PREFIXES.some(
        (prefix) => remaining.startsWith(prefix) || prefix.startsWith(remaining),
      )
    ) {
      const end = remaining.indexOf(">");
      if (end < 0 && remaining.length < MAX_PENDING_REFERENCE) {
        state.pending = remaining;
        offset = input.length;
        break;
      }
      if (end >= 0) {
        output += devinReferenceLink(remaining.slice(0, end + 1), cloudUrl);
        offset = token.index + end + 1;
        tokens.lastIndex = offset;
        continue;
      }
    }
    output += value;
  }
  return output + input.slice(offset);
}
