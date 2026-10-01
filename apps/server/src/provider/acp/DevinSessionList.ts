import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpSchema from "effect-acp/schema";

import type { ProviderNativeSession } from "../Services/ProviderAdapter.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MAX_PAGES = 20;

const decodeListSessionsResponse = Schema.decodeUnknownEffect(EffectAcpSchema.ListSessionsResponse);

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function metaRepositories(meta: Readonly<Record<string, unknown>>): ReadonlyArray<string> {
  const value = meta["cognition.ai/sessionRepos"];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) return [];
    return typeof entry.name === "string" && entry.name ? [entry.name] : [];
  });
}

/** Maps an ACP `session/list` entry, reading Devin's `cognition.ai/*` metadata when present. */
export function devinNativeSessionFromAcp(
  info: EffectAcpSchema.SessionInfo,
): ProviderNativeSession | undefined {
  const meta = info._meta ?? {};
  if (meta["cognition.ai/isArchived"] === true) return undefined;
  const sessionId = info.sessionId.trim();
  if (!sessionId) return undefined;
  return {
    sessionId,
    title: info.title?.trim() || null,
    cwd: info.cwd.trim() || null,
    updatedAt: info.updatedAt ?? null,
    url: metaString(meta, "cognition.ai/url"),
    status: metaString(meta, "cognition.ai/statusEnum"),
    repositories: metaRepositories(meta),
    excerpt: metaString(meta, "cognition.ai/messageExcerpts"),
  };
}

/** Lists stored sessions through ACP `session/list`, following `nextCursor`. */
export const listDevinAcpSessions = Effect.fn("listDevinAcpSessions")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "initialize" | "request">,
) {
  yield* runtime.initialize();
  const sessions: Array<ProviderNativeSession> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* runtime
      .request("session/list", cursor ? { cursor } : {})
      .pipe(Effect.flatMap(decodeListSessionsResponse));
    for (const info of response.sessions) {
      const session = devinNativeSessionFromAcp(info);
      if (session) sessions.push(session);
    }
    cursor = response.nextCursor?.trim() || undefined;
    if (!cursor) break;
  }
  return sessions;
});
