import { describe, expect, it } from "@effect/vitest";

import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime.ts";
import { makeDevinReferenceNormalizer } from "./DevinReferences.ts";

const normalize = (
  chunks: string[],
  options?: Parameters<typeof makeDevinReferenceNormalizer>[0],
  rawPayload: unknown = {},
) => {
  const transform = makeDevinReferenceNormalizer(options);
  const events: AcpSessionRuntimeEvent[] = [
    { _tag: "AssistantItemStarted", itemId: "message" },
    ...chunks.map((text) => ({
      _tag: "ContentDelta" as const,
      itemId: "message",
      text,
      rawPayload,
    })),
    { _tag: "AssistantItemCompleted", itemId: "message" },
  ];
  return events
    .flatMap(transform)
    .filter((event) => event._tag === "ContentDelta")
    .map((event) => event.text)
    .join("");
};

describe("Devin references", () => {
  it("accepts file references, reordered attributes, and single line snippets", () => {
    expect(
      normalize([
        '<ref_file file="/workspace/README.md"/> and ',
        "<ref_snippet lines='12' file='/workspace/src/main.ts' />",
      ]),
    ).toBe("[README.md](/workspace/README.md) and [main.ts:12](/workspace/src/main.ts#L12)");
  });

  it("escapes Markdown and URL characters in file names", () => {
    expect(normalize(['<ref_file file="/workspace/a [b]#(c)&amp;d.md" />'])).toBe(
      "[a \\[b\\]#(c)&d.md](/workspace/a%20%5Bb%5D%23%28c%29%26d.md)",
    );
  });

  it("preserves incomplete references and malformed tags", () => {
    for (const text of [
      "less < than",
      "ending <ref_",
      '<ref_file file="/workspace/a.ts"',
      '<ref_file lines="1" />',
      '<ref_snippet file="/workspace/a.ts" lines="bad" />',
      '<ref_file file="javascript:alert(1)" />',
    ]) {
      expect(normalize([...text])).toBe(text);
    }
  });

  it("streams ordinary text immediately and leaves non-message events untouched", () => {
    const transform = makeDevinReferenceNormalizer();
    const event = { _tag: "AssistantItemStarted" as const, itemId: "message" };
    expect(transform(event)).toEqual([event]);
    const delta = { _tag: "ContentDelta" as const, text: "ordinary text", rawPayload: {} };
    expect(transform(delta)).toEqual([delta]);
  });
});
