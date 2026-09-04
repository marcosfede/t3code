import { describe, expect, it } from "@effect/vitest";

import {
  buildDevinFamilyOptionDescriptors,
  buildDevinModelFamilies,
  isCurrentDevinModelFamily,
  parseDevinModelSlug,
  resolveDevinConcreteModelId,
} from "./DevinModelCatalog.ts";

// Subset of the flat `model` select the Devin CLI advertises over ACP.
const FIXTURE_DEVIN_MODEL_OPTIONS = [
  { value: "claude-opus-5-low", name: "Claude Opus 5 Low" },
  { value: "claude-opus-5-medium", name: "Claude Opus 5 Medium" },
  { value: "claude-opus-5-high", name: "Claude Opus 5 High" },
  { value: "claude-opus-5-high-fast", name: "Claude Opus 5 High Fast" },
  { value: "gpt-5-6-sol-none", name: "GPT-5.6 Sol No Thinking" },
  { value: "gpt-5-6-sol-low-priority", name: "GPT-5.6 Sol Low Thinking Fast" },
  { value: "gpt-5-6-sol-max-ultrafast", name: "GPT-5.6 Sol Max Thinking Ultrafast" },
  { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
  { value: "claude-opus-4-6-1m", name: "Claude Opus 4.6 1M" },
  { value: "claude-opus-4-6-thinking-1m", name: "Claude Opus 4.6 Thinking 1M" },
  { value: "claude-opus-4-6-1m-max", name: "Claude Opus 4.6 1M Max [dev]" },
  { value: "claude-opus-4-6-thinking-1m-max", name: "Claude Opus 4.6 Thinking 1M Max [dev]" },
  { value: "MODEL_CLAUDE_4_5_OPUS", name: "Claude Opus 4.5" },
  { value: "MODEL_CLAUDE_4_5_OPUS_THINKING", name: "Claude Opus 4.5 Thinking" },
  { value: "MODEL_PRIVATE_2", name: "Claude Sonnet 4.5" },
  { value: "MODEL_PRIVATE_3", name: "Claude Sonnet 4.5 Thinking" },
  { value: "MODEL_PRIVATE_11", name: "Claude Haiku 4.5" },
  { value: "MODEL_PRIVATE_12", name: "GPT-5.1 No Thinking" },
  { value: "MODEL_PRIVATE_13", name: "GPT-5.1 Low Thinking" },
  { value: "MODEL_PRIVATE_14", name: "GPT-5.1 Medium Thinking" },
  { value: "MODEL_PRIVATE_15", name: "GPT-5.1 High Thinking" },
  {
    value: "fusion-gpt-5-6-sol-medium-sidekick-swe-1-7-medium",
    name: "Fusion (GPT-5.6 Sol Medium Thinking + SWE-1.7 Medium)",
  },
  {
    value: "fusion-gpt-5-6-sol-high-fast-sidekick-gpt-5-6-luna-high-priority",
    name: "Fusion (GPT-5.6 Sol High Thinking Fast + GPT-5.6 Luna High Thinking Fast)",
  },
  {
    value: "fusion-gpt-5-6-sol-high-sidekick-gpt-5-6-luna-high",
    name: "Fusion (GPT-5.6 Sol High Thinking + GPT-5.6 Luna High Thinking)",
  },
  {
    value: "fusion-claude-opus-5-low-sidekick-glm-5-2",
    name: "Fusion (Claude Opus 5 Low + GLM-5.2 High)",
  },
  { value: "swe-1-6", name: "SWE-1.6" },
  { value: "swe-1-6-fast", name: "SWE-1.6 Fast" },
  { value: "gpt-5-3-codex-medium", name: "GPT-5.3-Codex Medium" },
  { value: "gpt-5-3-codex-xhigh", name: "GPT-5.3-Codex X-High" },
  { value: "neptune-high", name: "Neptune High" },
];

const families = buildDevinModelFamilies(FIXTURE_DEVIN_MODEL_OPTIONS);
const familyBySlug = (slug: string) => {
  const family = families.find((candidate) => candidate.slug === slug);
  if (!family) throw new Error(`missing family ${slug}`);
  return family;
};
const supportedModelIds = new Set(FIXTURE_DEVIN_MODEL_OPTIONS.map((option) => option.value));

describe("parseDevinModelSlug", () => {
  it("strips trailing option tokens in any order", () => {
    expect(parseDevinModelSlug("claude-opus-5-high-fast")).toEqual({
      baseSlug: "claude-opus-5",
      effort: "high",
      speed: "fast",
    });
    expect(parseDevinModelSlug("gpt-5-6-sol-low-priority")).toEqual({
      baseSlug: "gpt-5-6-sol",
      effort: "low",
      speed: "fast",
    });
    expect(parseDevinModelSlug("gpt-5-6-sol-max-ultrafast")).toEqual({
      baseSlug: "gpt-5-6-sol",
      effort: "max",
      speed: "ultrafast",
    });
    expect(parseDevinModelSlug("claude-opus-4-6-thinking-1m")).toEqual({
      baseSlug: "claude-opus-4-6",
      contextWindow: "1m",
      thinking: true,
    });
    expect(parseDevinModelSlug("claude-opus-4-6-1m-max")).toEqual({
      baseSlug: "claude-opus-4-6",
      effort: "max",
      contextWindow: "1m",
    });
  });

  it("handles uppercase underscore-separated legacy ids", () => {
    expect(parseDevinModelSlug("MODEL_CLAUDE_4_5_OPUS_THINKING")).toEqual({
      baseSlug: "MODEL_CLAUDE_4_5_OPUS",
      thinking: true,
    });
  });

  it("recognizes options encoded by opaque legacy ids", () => {
    expect(parseDevinModelSlug("MODEL_PRIVATE_2")).toEqual({
      baseSlug: "claude-sonnet-4-5",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_3")).toEqual({
      baseSlug: "claude-sonnet-4-5",
      thinking: true,
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_12")).toEqual({
      baseSlug: "gpt-5-1",
      effort: "none",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_13")).toEqual({
      baseSlug: "gpt-5-1",
      effort: "low",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_14")).toEqual({
      baseSlug: "gpt-5-1",
      effort: "medium",
    });
    expect(parseDevinModelSlug("MODEL_PRIVATE_15")).toEqual({
      baseSlug: "gpt-5-1",
      effort: "high",
    });
  });

  it("splits fusion combos into primary options plus a sidekick", () => {
    expect(parseDevinModelSlug("fusion-gpt-5-6-sol-medium-sidekick-swe-1-7-medium")).toEqual({
      baseSlug: "fusion-gpt-5-6-sol",
      effort: "medium",
      sidekick: "swe-1-7-medium",
    });
    expect(
      parseDevinModelSlug("fusion-gpt-5-6-sol-high-fast-sidekick-gpt-5-6-luna-high-priority"),
    ).toEqual({
      baseSlug: "fusion-gpt-5-6-sol",
      effort: "high",
      speed: "fast",
      sidekick: "gpt-5-6-luna-high",
    });
    expect(parseDevinModelSlug("fusion-claude-opus-5-low-sidekick-glm-5-2")).toEqual({
      baseSlug: "fusion-claude-opus-5",
      effort: "low",
      sidekick: "glm-5-2",
    });
  });

  it("keeps token-only ids whole", () => {
    expect(parseDevinModelSlug("max")).toEqual({ baseSlug: "max" });
  });
});

describe("buildDevinModelFamilies", () => {
  it("groups variants under their base slug with a cleaned display name", () => {
    expect(familyBySlug("claude-opus-4-6").variants.map((variant) => variant.slug)).toEqual([
      "claude-opus-4-6",
      "claude-opus-4-6-thinking",
      "claude-opus-4-6-1m",
      "claude-opus-4-6-thinking-1m",
      "claude-opus-4-6-1m-max",
      "claude-opus-4-6-thinking-1m-max",
    ]);
    expect(familyBySlug("claude-opus-4-6").name).toBe("Claude Opus 4.6");
    expect(familyBySlug("gpt-5-6-sol").name).toBe("GPT-5.6 Sol");
    expect(familyBySlug("gpt-5-3-codex").name).toBe("GPT-5.3-Codex");
    expect(familyBySlug("MODEL_CLAUDE_4_5_OPUS").variants).toHaveLength(2);
    expect(familyBySlug("claude-sonnet-4-5")).toMatchObject({
      name: "Claude Sonnet 4.5",
      variants: [{ slug: "MODEL_PRIVATE_2" }, { slug: "MODEL_PRIVATE_3" }],
    });
    expect(familyBySlug("gpt-5-1")).toMatchObject({
      name: "GPT-5.1",
      variants: [
        { slug: "MODEL_PRIVATE_12" },
        { slug: "MODEL_PRIVATE_13" },
        { slug: "MODEL_PRIVATE_14" },
        { slug: "MODEL_PRIVATE_15" },
      ],
    });
  });

  it("groups fusion combos by primary model and names them after it", () => {
    expect(familyBySlug("fusion-gpt-5-6-sol")).toMatchObject({
      name: "Fusion (GPT-5.6 Sol)",
      variants: [
        { slug: "fusion-gpt-5-6-sol-medium-sidekick-swe-1-7-medium" },
        { slug: "fusion-gpt-5-6-sol-high-fast-sidekick-gpt-5-6-luna-high-priority" },
        { slug: "fusion-gpt-5-6-sol-high-sidekick-gpt-5-6-luna-high" },
      ],
    });
  });

  it("collapses single-variant groups to the concrete slug and name", () => {
    expect(familyBySlug("MODEL_PRIVATE_11").name).toBe("Claude Haiku 4.5");
    expect(familyBySlug("neptune-high").name).toBe("Neptune High");
    expect(families.some((family) => family.slug === "neptune")).toBe(false);
    expect(familyBySlug("fusion-claude-opus-5-low-sidekick-glm-5-2").name).toBe(
      "Fusion (Claude Opus 5 Low + GLM-5.2 High)",
    );
  });
});

describe("isCurrentDevinModelFamily", () => {
  it("allowlists frontier families by grouped slug and treats everything else as legacy", () => {
    for (const slug of [
      "claude-opus-5",
      "gpt-5-6-sol",
      "fusion-gpt-5-6-sol",
      "swe-1-7",
      "adaptive",
    ]) {
      expect(isCurrentDevinModelFamily(slug), slug).toBe(true);
    }
    for (const slug of [
      "claude-opus-4-6",
      "MODEL_CLAUDE_4_5_OPUS",
      "claude-sonnet-4-5",
      "gpt-5-1",
      "gpt-5-3-codex",
      "swe-1-6",
      "swe-1-6-fast",
      "atlas3",
      "adaptive-dev",
      "neptune-high",
      "unknown-new-model",
    ]) {
      expect(isCurrentDevinModelFamily(slug), slug).toBe(false);
    }
  });
});

describe("buildDevinFamilyOptionDescriptors", () => {
  const descriptorById = (
    descriptors: ReadonlyArray<{ id: string }>,
    id: string,
  ): Record<string, unknown> => {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (!descriptor) throw new Error(`missing descriptor ${id}`);
    return descriptor;
  };

  it("derives defaults from the session's current model when it is in the family", () => {
    const descriptors = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("claude-opus-5"),
      sessionCurrentValue: "claude-opus-5-high-fast",
    });
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["reasoning", "speed"]);
    expect(descriptorById(descriptors, "reasoning")).toMatchObject({
      currentValue: "high",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
      ],
    });
    expect(descriptorById(descriptors, "speed")).toMatchObject({
      currentValue: "fast",
      options: [
        { id: "standard", label: "Standard" },
        { id: "fast", label: "Fast", isDefault: true },
      ],
    });
  });

  it("falls back to medium/standard when the current model is outside the family", () => {
    const descriptors = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("claude-opus-5"),
      sessionCurrentValue: "swe-1-6",
    });
    expect(descriptorById(descriptors, "reasoning")).toMatchObject({ currentValue: "medium" });
    expect(descriptorById(descriptors, "speed")).toMatchObject({ currentValue: "standard" });
  });

  it("exposes a Default reasoning choice, context window and thinking for mixed families", () => {
    const active = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("claude-opus-4-6"),
      sessionCurrentValue: "claude-opus-4-6-thinking-1m",
    });
    expect(active.map((descriptor) => descriptor.id)).toEqual([
      "reasoning",
      "contextWindow",
      "thinking",
    ]);
    expect(descriptorById(active, "reasoning")).toMatchObject({
      currentValue: "default",
      options: [
        { id: "default", label: "Default", isDefault: true },
        { id: "max", label: "Max" },
      ],
    });
    expect(descriptorById(active, "contextWindow")).toMatchObject({ currentValue: "1m" });
    expect(descriptorById(active, "thinking")).toMatchObject({ currentValue: true });

    const inactive = buildDevinFamilyOptionDescriptors({ family: familyBySlug("claude-opus-4-6") });
    expect(descriptorById(inactive, "contextWindow")).toMatchObject({ currentValue: "default" });
    expect(descriptorById(inactive, "thinking")).toMatchObject({ currentValue: false });
  });

  it("includes every speed tier the family offers", () => {
    const descriptors = buildDevinFamilyOptionDescriptors({ family: familyBySlug("gpt-5-6-sol") });
    expect(descriptorById(descriptors, "speed")).toMatchObject({
      currentValue: "standard",
      options: [
        { id: "standard", label: "Standard", isDefault: true },
        { id: "fast", label: "Fast" },
        { id: "ultrafast", label: "Ultrafast" },
      ],
    });
    expect(descriptorById(descriptors, "reasoning")).toMatchObject({
      options: [
        { id: "none", label: "None" },
        { id: "low", label: "Low" },
        { id: "max", label: "Max" },
      ],
    });
  });

  it("exposes options for opaque legacy model families", () => {
    const sonnet = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("claude-sonnet-4-5"),
    });
    expect(descriptorById(sonnet, "thinking")).toMatchObject({ currentValue: false });

    const gpt = buildDevinFamilyOptionDescriptors({ family: familyBySlug("gpt-5-1") });
    expect(descriptorById(gpt, "reasoning")).toMatchObject({
      currentValue: "medium",
      options: [
        { id: "none", label: "None" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
    });
  });

  it("exposes a sidekick select for fusion families, labelled from the variant names", () => {
    const descriptors = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("fusion-gpt-5-6-sol"),
      sessionCurrentValue: "fusion-gpt-5-6-sol-high-fast-sidekick-gpt-5-6-luna-high-priority",
    });
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      "reasoning",
      "speed",
      "sidekick",
    ]);
    expect(descriptorById(descriptors, "sidekick")).toMatchObject({
      currentValue: "gpt-5-6-luna-high",
      options: [
        { id: "swe-1-7-medium", label: "SWE-1.7 Medium" },
        { id: "gpt-5-6-luna-high", label: "GPT-5.6 Luna High Thinking", isDefault: true },
      ],
    });
    expect(descriptorById(descriptors, "speed")).toMatchObject({ currentValue: "fast" });

    const inactive = buildDevinFamilyOptionDescriptors({
      family: familyBySlug("fusion-gpt-5-6-sol"),
    });
    expect(descriptorById(inactive, "sidekick")).toMatchObject({ currentValue: "swe-1-7-medium" });
  });

  it("returns no descriptors for flat models", () => {
    expect(buildDevinFamilyOptionDescriptors({ family: familyBySlug("MODEL_PRIVATE_11") })).toEqual(
      [],
    );
  });
});

describe("resolveDevinConcreteModelId", () => {
  it("resolves a family plus options to the exact variant", () => {
    expect(
      resolveDevinConcreteModelId({
        model: "claude-opus-5",
        options: [
          { id: "reasoning", value: "high" },
          { id: "speed", value: "fast" },
        ],
        supportedModelIds,
      }),
    ).toBe("claude-opus-5-high-fast");
    expect(
      resolveDevinConcreteModelId({
        model: "claude-opus-4-6",
        options: [
          { id: "contextWindow", value: "1m" },
          { id: "thinking", value: true },
        ],
        supportedModelIds,
      }),
    ).toBe("claude-opus-4-6-thinking-1m");
    expect(
      resolveDevinConcreteModelId({
        model: "claude-sonnet-4-5",
        options: [{ id: "thinking", value: true }],
        supportedModelIds,
      }),
    ).toBe("MODEL_PRIVATE_3");
    expect(
      resolveDevinConcreteModelId({
        model: "gpt-5-1",
        options: [{ id: "reasoning", value: "high" }],
        supportedModelIds,
      }),
    ).toBe("MODEL_PRIVATE_15");
    expect(
      resolveDevinConcreteModelId({
        model: "fusion-gpt-5-6-sol",
        options: [
          { id: "reasoning", value: "high" },
          { id: "speed", value: "fast" },
          { id: "sidekick", value: "gpt-5-6-luna-high" },
        ],
        supportedModelIds,
      }),
    ).toBe("fusion-gpt-5-6-sol-high-fast-sidekick-gpt-5-6-luna-high-priority");
    expect(
      resolveDevinConcreteModelId({
        model: "fusion-gpt-5-6-sol",
        options: [{ id: "sidekick", value: "gpt-5-6-luna-high" }],
        supportedModelIds,
      }),
    ).toBe("fusion-gpt-5-6-sol-high-sidekick-gpt-5-6-luna-high");
  });

  it("uses the family defaults for unselected options", () => {
    expect(resolveDevinConcreteModelId({ model: "claude-opus-5", supportedModelIds })).toBe(
      "claude-opus-5-medium",
    );
    expect(resolveDevinConcreteModelId({ model: "swe-1-6", supportedModelIds })).toBe("swe-1-6");
    expect(resolveDevinConcreteModelId({ model: "claude-opus-4-6", supportedModelIds })).toBe(
      "claude-opus-4-6",
    );
  });

  it("prefers the explicitly chosen value when the option matrix is sparse", () => {
    // Max only exists together with 1M for Claude 4.6; the chosen Max wins over the default context.
    expect(
      resolveDevinConcreteModelId({
        model: "claude-opus-4-6",
        options: [
          { id: "reasoning", value: "max" },
          { id: "contextWindow", value: "default" },
        ],
        supportedModelIds,
      }),
    ).toBe("claude-opus-4-6-1m-max");
  });

  it("passes concrete and unknown ids through unchanged", () => {
    expect(resolveDevinConcreteModelId({ model: "swe-1-6-fast", supportedModelIds })).toBe(
      "swe-1-6-fast",
    );
    expect(resolveDevinConcreteModelId({ model: "MODEL_PRIVATE_12", supportedModelIds })).toBe(
      "MODEL_PRIVATE_12",
    );
    expect(resolveDevinConcreteModelId({ model: "unknown-model", supportedModelIds })).toBe(
      "unknown-model",
    );
    expect(
      resolveDevinConcreteModelId({
        model: "claude-opus-5",
        options: [{ id: "reasoning", value: "high" }],
        supportedModelIds: undefined,
      }),
    ).toBe("claude-opus-5");
  });

  it("returns undefined for an empty model", () => {
    expect(resolveDevinConcreteModelId({ model: undefined, supportedModelIds })).toBeUndefined();
    expect(resolveDevinConcreteModelId({ model: "  ", supportedModelIds })).toBeUndefined();
  });
});
