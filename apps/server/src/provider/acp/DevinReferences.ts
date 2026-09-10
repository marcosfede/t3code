import * as Predicate from "effect/Predicate";

import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";

const REFERENCE_PREFIXES = ["<ref_file", "<ref_snippet"];
const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

const record = (value: unknown) => (Predicate.isObject(value) ? value : undefined);

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

function referenceLink(tag: string, cloudUrl: string | null | undefined): string {
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

export function makeDevinReferenceNormalizer(
  options: { readonly cloud?: boolean; readonly sessionMetadata?: unknown } = {},
) {
  let sessionUrl = sessionUrlFromMetadata(options.sessionMetadata);
  let messageTimestamp: number | undefined;
  let pending = "";
  let codeDelimiter = "";
  let lastDelta: Extract<AcpSessionRuntimeEvent, { _tag: "ContentDelta" }> | undefined;

  return (event: AcpSessionRuntimeEvent): AcpSessionRuntimeEvent[] => {
    const payload = "rawPayload" in event ? record(event.rawPayload) : undefined;
    const updateMeta = record(record(payload?.update)?._meta);
    if (options.cloud) {
      sessionUrl =
        sessionUrlFromMetadata(record(payload?._meta)?.["cognition.ai/session"]) ??
        sessionUrlFromMetadata(updateMeta?.["cognition.ai/session"]) ??
        sessionUrl;
    }
    if (event._tag === "AssistantItemStarted" || event._tag === "AssistantItemCompleted") {
      const tail =
        event._tag === "AssistantItemCompleted" && pending && lastDelta
          ? [{ ...lastDelta, text: pending }]
          : [];
      pending = "";
      codeDelimiter = "";
      lastDelta = undefined;
      messageTimestamp = undefined;
      return [...tail, event];
    }
    if (event._tag !== "ContentDelta") return [event];
    let cloudUrl: string | null | undefined;
    if (options.cloud) {
      const value = updateMeta?.["cognition.ai/timestamp"];
      const timestamp = typeof value === "string" ? Date.parse(value) : value;
      if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
        messageTimestamp = timestamp;
      }
      const url = sessionUrl ? new URL(sessionUrl) : undefined;
      if (url && messageTimestamp !== undefined)
        url.searchParams.set("ts", String(messageTimestamp));
      cloudUrl = url?.toString() ?? null;
    }
    lastDelta = event;
    const input = pending + event.text;
    pending = "";
    let output = "";
    let offset = 0;
    const tokens = /\\[\s\S]?|`+|~+|</g;
    for (let token = tokens.exec(input); token; token = tokens.exec(input)) {
      output += input.slice(offset, token.index);
      offset = tokens.lastIndex;
      const value = token[0];
      if (value !== "<") {
        if (offset === input.length && (value === "\\" || !value.startsWith("\\"))) {
          pending = value;
          break;
        }
        if (value === codeDelimiter) codeDelimiter = "";
        else if (
          !codeDelimiter &&
          (value.startsWith("`") || (value.length >= 3 && value.startsWith("~")))
        ) {
          codeDelimiter = value;
        }
        output += value;
        continue;
      }
      const remaining = input.slice(token.index);
      if (
        !codeDelimiter &&
        REFERENCE_PREFIXES.some(
          (prefix) => remaining.startsWith(prefix) || prefix.startsWith(remaining),
        )
      ) {
        const end = remaining.indexOf(">");
        if (end < 0 && remaining.length < 8192) {
          pending = remaining;
          offset = input.length;
          break;
        }
        if (end >= 0) {
          output += referenceLink(remaining.slice(0, end + 1), cloudUrl);
          offset = token.index + end + 1;
          tokens.lastIndex = offset;
          continue;
        }
      }
      output += value;
    }
    output += input.slice(offset);
    return output ? [{ ...event, text: output }] : [];
  };
}
