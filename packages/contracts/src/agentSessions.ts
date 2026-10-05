import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Coding agent home directories the scanner knows how to read. */
export const AgentSessionSource = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionSource = typeof AgentSessionSource.Type;

/** File identity saved with an imported session so bounded retries can skip unchanged history. */
export const AgentSessionImportSource = Schema.Struct({
  provider: AgentSessionSource,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: TrimmedNonEmptyString,
  filePath: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.NullOr(Schema.Number),
  device: Schema.Number,
  inode: Schema.NullOr(Schema.Number),
  birthtimeMs: Schema.NullOr(Schema.Number),
});
export type AgentSessionImportSource = typeof AgentSessionImportSource.Type;

/**
 * Empty for now. Kept as a struct so future scan options (source filters,
 * explicit roots) can be added without a new method.
 */
export const AgentSessionScanInput = Schema.Struct({});
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A directory that at least one agent CLI has run in, suitable for import as a
 * T3 Code project. `alreadyImported` marks candidates that already have an
 * active project rooted at the same path.
 */
/**
 * Git identity of a candidate directory, read from `.git/config` without
 * spawning git. `remoteKey` is the normalized origin URL, shared by every
 * clone of the same repository so the client can group them. `repository`
 * is the GitHub `owner/name` when the origin is on GitHub.
 */
export const AgentSessionProjectGit = Schema.Struct({
  remoteKey: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
});
export type AgentSessionProjectGit = typeof AgentSessionProjectGit.Type;

export const AgentSessionProjectCandidate = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
  sources: Schema.Array(AgentSessionSource),
  threadCount: NonNegativeInt,
  lastActiveAt: Schema.NullOr(IsoDateTime),
  alreadyImported: Schema.Boolean,
  /**
   * `null` when the directory is not the root of a git repository. Missing on
   * servers that predate the git scan, where the client cannot tell repositories
   * from plain folders and should treat every candidate as a standalone project.
   */
  git: Schema.optionalKey(Schema.NullOr(AgentSessionProjectGit)),
});
export type AgentSessionProjectCandidate = typeof AgentSessionProjectCandidate.Type;

export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionProjectCandidate),
  scannedAt: IsoDateTime,
  truncated: Schema.optional(Schema.Boolean),
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export function parseDevinCloudSessionId(value: string): string | undefined {
  const input = value.trim();
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(input)) return input;
  const url = URL.parse(input);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(url.hostname === "devin.ai" || url.hostname.endsWith(".devin.ai"))
  )
    return undefined;
  const match = /^\/sessions\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\/?$/.exec(url.pathname);
  return match?.[1];
}

/** A session stored by a Devin Cloud provider instance. */
export const DevinSessionSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  repositories: Schema.Array(Schema.String),
  excerpt: Schema.NullOr(Schema.String),
});
export type DevinSessionSummary = typeof DevinSessionSummary.Type;

const DevinSessionCursor = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cursor: TrimmedNonEmptyString,
});

export const DevinSessionListInput = Schema.Struct({
  /** Omit for the first page; subsequent requests only advance these providers. */
  cursors: Schema.optionalKey(Schema.Array(DevinSessionCursor)),
  /** Searches session titles and message content across account history. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Without a query, keeps sessions updated at or after this instant. */
  updatedAfter: Schema.optionalKey(IsoDateTime),
});
export type DevinSessionListInput = typeof DevinSessionListInput.Type;

export const DevinSessionListResult = Schema.Struct({
  sessions: Schema.Array(DevinSessionSummary),
  nextCursors: Schema.optionalKey(Schema.Array(DevinSessionCursor)),
  /** Provider instances whose sessions could not be listed. */
  failures: Schema.Array(
    Schema.Struct({ providerInstanceId: ProviderInstanceId, detail: Schema.String }),
  ),
});
export type DevinSessionListResult = typeof DevinSessionListResult.Type;

export function matchesDevinSessionQuery(
  session: Pick<DevinSessionSummary, "title" | "sessionId" | "cwd" | "excerpt" | "repositories">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [session.title, session.sessionId, session.cwd, session.excerpt, ...session.repositories]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLowerCase().includes(needle));
}

export const DevinCloudSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  session: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type DevinCloudSessionImportInput = typeof DevinCloudSessionImportInput.Type;

export const DevinCloudSessionImportResult = Schema.Struct({
  threadId: ThreadId,
  /** Set when the session was already in T3 as an archived thread, which is left archived. */
  archived: Schema.optionalKey(Schema.Boolean),
});
export type DevinCloudSessionImportResult = typeof DevinCloudSessionImportResult.Type;

export class DevinCloudSessionImportError extends Schema.TaggedError<DevinCloudSessionImportError>()(
  "DevinCloudSessionImportError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  expectedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

export class AgentSessionImportProjectNotFoundError extends Schema.TaggedError<AgentSessionImportProjectNotFoundError>()(
  "AgentSessionImportProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' does not exist.`;
  }
}

export class AgentSessionImportProjectChangedError extends Schema.TaggedError<AgentSessionImportProjectChangedError>()(
  "AgentSessionImportProjectChangedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project '${this.projectId}' changed directories. Scan for projects again before importing history.`;
  }
}

export const AgentSessionImportResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionScanError extends Schema.TaggedError<AgentSessionScanError>()(
  "AgentSessionScanError",
  {
    operation: Schema.Literals(["read-settings", "read-projects"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to scan agent sessions during ${this.operation}.`;
  }
}
