import type { ProviderOptionDescriptor, ProviderOptionSelection } from "@t3tools/contracts";
import {
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";

import { buildBooleanOptionDescriptor, buildSelectOptionDescriptor } from "../providerSnapshot.ts";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
const SPEEDS: Record<string, "fast" | "ultrafast"> = {
  fast: "fast",
  priority: "fast",
  ultrafast: "ultrafast",
};
const isEffort = (token: string): token is Effort =>
  (EFFORTS as ReadonlyArray<string>).includes(token);

/** Option dimensions a concrete Devin model id encodes as trailing slug tokens.
 * A missing dimension means the family's plain variant along that axis.
 * `sidekick` is the secondary model of a Fusion combo (`fusion-<primary>-<options>-sidekick-<sidekick>`). */
interface DevinVariantOptions {
  readonly effort?: Effort;
  readonly speed?: "fast" | "ultrafast";
  readonly contextWindow?: "1m";
  readonly thinking?: true;
  readonly sidekick?: string;
}

const FUSION_SIDEKICK_SEPARATOR = "-sidekick-";
const FUSION_NAME = /^Fusion \((.+?) \+ (.+)\)$/;

const OPAQUE_MODEL_VARIANTS = new Map<string, { readonly baseSlug: string } & DevinVariantOptions>([
  ["MODEL_PRIVATE_2", { baseSlug: "claude-sonnet-4-5" }],
  ["MODEL_PRIVATE_3", { baseSlug: "claude-sonnet-4-5", thinking: true }],
  ["MODEL_PRIVATE_12", { baseSlug: "gpt-5-1", effort: "none" }],
  ["MODEL_PRIVATE_13", { baseSlug: "gpt-5-1", effort: "low" }],
  ["MODEL_PRIVATE_14", { baseSlug: "gpt-5-1", effort: "medium" }],
  ["MODEL_PRIVATE_15", { baseSlug: "gpt-5-1", effort: "high" }],
]);

/**
 * Frontier families shown in the main picker list, keyed on the grouped
 * family slug. Everything Devin advertises outside this list (older
 * generations, unreleased codenames, dev routers) folds under Legacy. Kept
 * in code rather than `model-manifest.json` because the manifest refreshes
 * from upstream, which has no Devin entry.
 */
const DEVIN_CURRENT_MODELS: ReadonlySet<string> = new Set([
  // Anthropic
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5",
  // OpenAI
  "gpt-6-astra",
  "gpt-5-6-sol",
  "gpt-5-6-luna",
  "gpt-5-6-terra",
  // Google
  "gemini-3-8-flash",
  // xAI
  "grok-4-6",
  // Zhipu
  "glm-5-3",
  "glm-5-3-flash",
  // Moonshot
  "kimi-k3",
  // DeepSeek
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  // NVIDIA
  "nemotron-3-ultra",
  // Cognition
  "swe-1-7",
  "swe-1-7-lightning",
  "adaptive",
  // Fusion combos of the above
  "fusion-gpt-5-6-sol",
  "fusion-claude-opus-5",
  "fusion-claude-fable-5-1",
  "fusion-atlas3",
]);

/** Whether a grouped family slug is on the frontier allowlist; false means legacy. */
export const isCurrentDevinModelFamily = (familySlug: string): boolean =>
  DEVIN_CURRENT_MODELS.has(familySlug);

export interface DevinModelVariant extends DevinVariantOptions {
  readonly slug: string;
  readonly name: string;
}

/** One picker entry: a family of variants sharing a base slug, or a single
 * ungroupable model (then `slug` is the concrete id and `variants` has one). */
export interface DevinModelFamily {
  readonly slug: string;
  readonly name: string;
  readonly variants: ReadonlyArray<DevinModelVariant>;
}

type MutableVariantOptions = { -readonly [K in keyof DevinVariantOptions]: DevinVariantOptions[K] };

/** Strips recognised option tokens off the end of a slug; ids made only of option tokens stay whole. */
function stripTrailingOptionTokens(slug: string): { baseSlug: string } & DevinVariantOptions {
  const tokens = [...slug.matchAll(/[^-_]+/g)];
  const options: MutableVariantOptions = {};
  let end = tokens.length;
  for (; end > 0; end--) {
    const token = tokens[end - 1]?.[0].toLowerCase() ?? "";
    const speed = SPEEDS[token];
    if (isEffort(token) && !options.effort) options.effort = token;
    else if (speed && !options.speed) options.speed = speed;
    else if (token === "1m" && !options.contextWindow) options.contextWindow = "1m";
    else if (token === "thinking" && !options.thinking) options.thinking = true;
    else break;
  }
  const last = tokens[end - 1];
  return last
    ? { baseSlug: slug.slice(0, last.index + last[0].length), ...options }
    : { baseSlug: slug };
}

/**
 * Splits a Devin model id into its family base and the option tokens it
 * encodes (`claude-opus-4-6-thinking-1m` → base `claude-opus-4-6`, thinking,
 * 1m). Fusion combos group by primary model, with the sidekick as one more
 * axis; the sidekick's own speed token folds into the combo's speed since
 * Devin only advertises them in lockstep.
 */
export function parseDevinModelSlug(slug: string): { baseSlug: string } & DevinVariantOptions {
  const opaqueVariant = OPAQUE_MODEL_VARIANTS.get(slug);
  if (opaqueVariant) return opaqueVariant;
  const sidekickAt = slug.startsWith("fusion-") ? slug.indexOf(FUSION_SIDEKICK_SEPARATOR) : -1;
  if (sidekickAt === -1) return stripTrailingOptionTokens(slug);
  const primary = stripTrailingOptionTokens(slug.slice(0, sidekickAt));
  const sidekickSpeed = slug
    .slice(sidekickAt + FUSION_SIDEKICK_SEPARATOR.length)
    .match(/^(.*?)(?:-(fast|priority|ultrafast))?$/i);
  const speed = primary.speed ?? (sidekickSpeed?.[2] ? SPEEDS[sidekickSpeed[2]] : undefined);
  return {
    ...primary,
    ...(speed ? { speed } : {}),
    sidekick: sidekickSpeed?.[1] ?? "",
  };
}

const TRAILING_OPTION_WORDS =
  /(?:^|[\s_-]+)(?:none|no|minimal|low|medium|high|x-?high|max|thinking|fast|ultrafast|1m|\[dev\])$/i;

const optionCount = (variant: DevinVariantOptions) =>
  [variant.effort, variant.speed, variant.contextWindow, variant.thinking].filter(Boolean).length;

const stripTrailingOptionWords = (name: string) => {
  while (TRAILING_OPTION_WORDS.test(name)) name = name.replace(TRAILING_OPTION_WORDS, "").trim();
  return name;
};

const plainestVariant = (variants: ReadonlyArray<DevinModelVariant>) =>
  variants.reduce((best, v) => (optionCount(v) < optionCount(best) ? v : best));

/** Family display name: the plainest variant's name with trailing option words
 * removed. Fusion combos keep only the primary half: `Fusion (GPT-5.6 Sol)`. */
function familyDisplayName(variants: ReadonlyArray<DevinModelVariant>, fallback: string): string {
  const name = plainestVariant(variants).name;
  const fusion = FUSION_NAME.exec(name);
  const stripped = stripTrailingOptionWords(fusion?.[1] ?? name);
  return stripped ? (fusion ? `Fusion (${stripped})` : stripped) : fallback;
}

/** Sidekick label from the plainest variant carrying it: the `+ …` half of the Fusion name. */
function sidekickLabel(variants: ReadonlyArray<DevinModelVariant>, sidekick: string): string {
  const name = plainestVariant(variants.filter((v) => v.sidekick === sidekick)).name;
  return FUSION_NAME.exec(name)?.[2] ?? sidekick;
}

/** Groups the flat ACP model list into families, preserving first-seen order and dropping duplicates. */
export function buildDevinModelFamilies(
  entries: ReadonlyArray<{ readonly value: string; readonly name?: string }>,
): ReadonlyArray<DevinModelFamily> {
  const groups = new Map<string, Array<DevinModelVariant>>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const { baseSlug, ...options } = parseDevinModelSlug(slug);
    const variant = { slug, name: entry.name?.trim() || slug, ...options };
    groups.get(baseSlug)?.push(variant) ?? groups.set(baseSlug, [variant]);
  }
  return [...groups].map(([baseSlug, variants]) => {
    const single = variants.length === 1 ? variants[0] : undefined;
    return single
      ? { slug: single.slug, name: single.name, variants }
      : { slug: baseSlug, name: familyDisplayName(variants, baseSlug), variants };
  });
}

/**
 * Default option values for a family: the session's active variant when it
 * belongs to the family, otherwise the plain/standard side of each axis
 * (medium reasoning when there is no plain variant). `undefined` means the
 * family has no variant along that axis.
 */
function familyDefaults(family: DevinModelFamily, active?: DevinModelVariant) {
  const has = (predicate: (variant: DevinModelVariant) => unknown) =>
    family.variants.some(predicate);
  return {
    reasoning: !has((v) => v.effort)
      ? undefined
      : (active?.effort ??
        (has((v) => !v.effort)
          ? "default"
          : has((v) => v.effort === "medium")
            ? "medium"
            : EFFORTS.find((effort) => has((v) => v.effort === effort)))),
    speed: !has((v) => v.speed)
      ? undefined
      : (active?.speed ??
        (has((v) => !v.speed) ? "standard" : family.variants.find((v) => v.speed)?.speed)),
    contextWindow: !has((v) => v.contextWindow) ? undefined : (active?.contextWindow ?? "default"),
    thinking: !has((v) => v.thinking)
      ? undefined
      : active
        ? active.thinking === true
        : !has((v) => !v.thinking),
    sidekick: active?.sidekick ?? family.variants.find((v) => v.sidekick)?.sidekick,
  };
}

const uniqueSidekicks = (family: DevinModelFamily) => [
  ...new Set(family.variants.flatMap((v) => (v.sidekick ? [v.sidekick] : []))),
];

/** Picker option descriptors for a multi-variant family; empty for flat models. */
export function buildDevinFamilyOptionDescriptors(input: {
  readonly family: DevinModelFamily;
  readonly sessionCurrentValue?: string | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { family } = input;
  if (family.variants.length < 2) return [];
  const has = (predicate: (variant: DevinModelVariant) => unknown) =>
    family.variants.some(predicate);
  const defaults = familyDefaults(
    family,
    family.variants.find((v) => v.slug === input.sessionCurrentValue),
  );
  const choices = (
    values: ReadonlyArray<readonly [string, string]>,
    selected: string | undefined,
  ) =>
    values.map(([value, label]) => ({
      value,
      label,
      ...(value === selected ? { isDefault: true } : {}),
    }));

  const descriptors: Array<ProviderOptionDescriptor> = [];
  if (defaults.reasoning) {
    descriptors.push(
      buildSelectOptionDescriptor({
        id: "reasoning",
        label: "Reasoning",
        options: choices(
          [
            ...(has((v) => !v.effort) ? [["default", "Default"] as const] : []),
            ...EFFORTS.filter((effort) => has((v) => v.effort === effort)).map(
              (effort) => [effort, EFFORT_LABELS[effort]] as const,
            ),
          ],
          defaults.reasoning,
        ),
      }),
    );
  }
  if (defaults.speed) {
    const speeds = [
      ["standard", "Standard"],
      ["fast", "Fast"],
      ["ultrafast", "Ultrafast"],
    ] as const;
    descriptors.push(
      buildSelectOptionDescriptor({
        id: "speed",
        label: "Speed",
        options: choices(
          speeds.filter(([value]) =>
            value === "standard" ? has((v) => !v.speed) : has((v) => v.speed === value),
          ),
          defaults.speed,
        ),
      }),
    );
  }
  if (defaults.contextWindow) {
    descriptors.push(
      buildSelectOptionDescriptor({
        id: "contextWindow",
        label: "Context Window",
        options: choices(
          [
            ["default", "Default"],
            ["1m", "1M"],
          ],
          defaults.contextWindow,
        ),
      }),
    );
  }
  if (defaults.thinking !== undefined) {
    descriptors.push(
      buildBooleanOptionDescriptor({
        id: "thinking",
        label: "Thinking",
        currentValue: defaults.thinking,
      }),
    );
  }
  if (defaults.sidekick) {
    descriptors.push(
      buildSelectOptionDescriptor({
        id: "sidekick",
        label: "Sidekick",
        options: choices(
          uniqueSidekicks(family).map((id) => [id, sidekickLabel(family.variants, id)] as const),
          defaults.sidekick,
        ),
      }),
    );
  }
  return descriptors;
}

/**
 * Maps a picker selection (family slug plus option values) to the concrete id
 * the session accepts. Concrete and unknown ids pass through unchanged so
 * stored threads, text generation and custom models keep working. When the
 * family's option matrix is sparse, the variant matching the most requested
 * dimensions wins; a match on an explicitly chosen option outranks a match on
 * a defaulted one, and a non-plain value (e.g. Max) outranks a plain one.
 */
export function resolveDevinConcreteModelId(input: {
  readonly model: string | null | undefined;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly supportedModelIds: ReadonlySet<string> | undefined;
}): string | undefined {
  const model = input.model?.trim();
  if (!model) return undefined;
  if (!input.supportedModelIds) return model;
  const family = buildDevinModelFamilies(
    [...input.supportedModelIds].map((value) => ({ value })),
  ).find((candidate) => candidate.slug === model);
  if (!family) return model;

  const defaults = familyDefaults(family);
  const selected = (id: string) => getProviderOptionStringSelectionValue(input.options, id);
  const selectedThinking = getProviderOptionBooleanSelectionValue(input.options, "thinking");
  const reasoning = selected("reasoning") ?? defaults.reasoning;
  const speed = selected("speed") ?? defaults.speed;
  const wanted = {
    effort: reasoning === "default" ? undefined : reasoning,
    speed: speed === "standard" ? undefined : speed,
    contextWindow:
      (selected("contextWindow") ?? defaults.contextWindow) === "1m" ? ("1m" as const) : undefined,
    thinking: (selectedThinking ?? defaults.thinking) ? (true as const) : undefined,
    sidekick: selected("sidekick") ?? defaults.sidekick,
  };
  const explicit: Record<keyof typeof wanted, boolean> = {
    effort: selected("reasoning") !== undefined,
    speed: selected("speed") !== undefined,
    contextWindow: selected("contextWindow") !== undefined,
    thinking: selectedThinking !== undefined,
    sidekick: selected("sidekick") !== undefined,
  };
  const score = (variant: DevinModelVariant) =>
    (Object.keys(wanted) as Array<keyof typeof wanted>).reduce(
      (total, key) =>
        variant[key] === wanted[key]
          ? total + 1 + (explicit[key] ? 1 : 0) + (wanted[key] === undefined ? 0 : 1)
          : total,
      0,
    );
  return family.variants.reduce((best, variant) => (score(variant) > score(best) ? variant : best))
    .slug;
}
