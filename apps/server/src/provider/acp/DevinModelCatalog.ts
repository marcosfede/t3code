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
 * A missing dimension means the family's plain variant along that axis. */
interface DevinVariantOptions {
  readonly effort?: Effort;
  readonly speed?: "fast" | "ultrafast";
  readonly contextWindow?: "1m";
  readonly thinking?: true;
}

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

/**
 * Splits a Devin model id into its family base and the option tokens it
 * encodes (`claude-opus-4-6-thinking-1m` → base `claude-opus-4-6`, thinking,
 * 1m). Fusion combos and ids made only of option tokens stay whole.
 */
export function parseDevinModelSlug(slug: string): { baseSlug: string } & DevinVariantOptions {
  if (slug.startsWith("fusion-")) return { baseSlug: slug };
  const tokens = [...slug.matchAll(/[^-_]+/g)];
  const options: { -readonly [K in keyof DevinVariantOptions]: DevinVariantOptions[K] } = {};
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

const TRAILING_OPTION_WORDS =
  /(?:^|[\s_-]+)(?:none|no|minimal|low|medium|high|x-?high|max|thinking|fast|ultrafast|1m|\[dev\])$/i;

const optionCount = (variant: DevinVariantOptions) =>
  [variant.effort, variant.speed, variant.contextWindow, variant.thinking].filter(Boolean).length;

/** Family display name: the plainest variant's name with trailing option words removed. */
function familyDisplayName(variants: ReadonlyArray<DevinModelVariant>, fallback: string): string {
  let name = variants.reduce((best, v) => (optionCount(v) < optionCount(best) ? v : best)).name;
  while (TRAILING_OPTION_WORDS.test(name)) name = name.replace(TRAILING_OPTION_WORDS, "").trim();
  return name || fallback;
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
  };
}

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
  return descriptors;
}

/**
 * Maps a picker selection (family slug plus option values) to the concrete id
 * the session accepts. Concrete and unknown ids pass through unchanged so
 * stored threads, text generation and custom models keep working. When the
 * family's option matrix is sparse, the variant matching the most requested
 * dimensions wins, with an explicitly chosen non-plain value (e.g. Max)
 * counting double so it beats a left-at-default one.
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
  const reasoning = selected("reasoning") ?? defaults.reasoning;
  const speed = selected("speed") ?? defaults.speed;
  const wanted = {
    effort: reasoning === "default" ? undefined : reasoning,
    speed: speed === "standard" ? undefined : speed,
    contextWindow:
      (selected("contextWindow") ?? defaults.contextWindow) === "1m" ? ("1m" as const) : undefined,
    thinking:
      (getProviderOptionBooleanSelectionValue(input.options, "thinking") ?? defaults.thinking)
        ? (true as const)
        : undefined,
  };
  const score = (variant: DevinModelVariant) =>
    (Object.keys(wanted) as Array<keyof typeof wanted>).reduce(
      (total, key) =>
        variant[key] === wanted[key] ? total + (wanted[key] === undefined ? 1 : 2) : total,
      0,
    );
  return family.variants.reduce((best, variant) => (score(variant) > score(best) ? variant : best))
    .slug;
}
