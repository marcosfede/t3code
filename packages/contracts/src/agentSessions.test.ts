import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult, parseDevinCloudSessionId } from "./agentSessions.ts";

describe("parseDevinCloudSessionId", () => {
  it("accepts session IDs and Devin links without forwarding query parameters", () => {
    expect(parseDevinCloudSessionId(" devin-abc123 ")).toBe("devin-abc123");
    expect(parseDevinCloudSessionId("https://app.devin.ai/sessions/abc123?ts=123#chat")).toBe(
      "abc123",
    );
    expect(parseDevinCloudSessionId("https://staging.devin.ai/sessions/abc123/")).toBe("abc123");
  });
  it.each([
    "",
    "hello world",
    "https://example.com/sessions/abc",
    "https://devin.ai.evil.com/sessions/abc",
    "https://user:secret@app.devin.ai/sessions/abc",
    "https://app.devin.ai/settings",
    "https://app.devin.ai/sessions/abc/extra",
    "a".repeat(201),
  ])("rejects invalid input: %s", (input) => {
    expect(parseDevinCloudSessionId(input)).toBeUndefined();
  });
});

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});
