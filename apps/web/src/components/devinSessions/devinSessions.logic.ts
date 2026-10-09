import type {
  DevinSessionFilters,
  DevinSessionListInput,
  DevinSessionOrigin,
  DevinSessionSummary,
} from "@t3tools/contracts";

interface ProjectCandidate {
  readonly workspaceRoot: string;
  readonly title: string;
}

function basename(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.split("/").at(-1)?.toLowerCase() ?? "";
}

/** Picks the project named after one of a Devin Cloud session's repositories. */
export function suggestDevinSessionProject<TProject extends ProjectCandidate>(
  session: Pick<DevinSessionSummary, "repositories">,
  projects: ReadonlyArray<TProject>,
): TProject | undefined {
  const repoNames = new Set(
    session.repositories.map((repository) => repository.split("/").at(-1)?.toLowerCase()),
  );
  return projects.find(
    (project) =>
      repoNames.has(basename(project.workspaceRoot)) || repoNames.has(project.title.toLowerCase()),
  );
}

export const DEVIN_DATE_PRESETS = ["today", "last_week", "last_2_weeks", "last_month"] as const;
export type DevinDatePreset = (typeof DEVIN_DATE_PRESETS)[number];

/** The origins Devin's filter offers; some stand for several origins Devin records. */
export const DEVIN_ORIGIN_FILTERS = [
  "webapp",
  "api",
  "cli",
  "desktop",
  "ios",
  "automation",
  "code_scan",
  "slack",
  "jira",
  "linear",
  "teams",
  "pylon",
] as const;
export type DevinOriginFilter = (typeof DEVIN_ORIGIN_FILTERS)[number];

const ORIGIN_ALIASES: Partial<Record<DevinOriginFilter, ReadonlyArray<DevinSessionOrigin>>> = {
  desktop: ["desktop", "devin_spaces", "vscode_extension"],
  automation: ["automation", "scheduled"],
};

/** What is ticked in the filters menu, shaped like Devin's own session filter. */
export interface DevinSessionFilterSelection {
  readonly sessionType: ReadonlyArray<"agent" | "ask">;
  readonly automation: "automations" | "not_automations" | null;
  readonly origin: ReadonlyArray<DevinOriginFilter>;
  readonly status: ReadonlyArray<"running" | "exit">;
  readonly prState: ReadonlyArray<"open" | "draft" | "merged" | "closed">;
  readonly done: ReadonlyArray<"done" | "notDone">;
  readonly createdTime: DevinDatePreset | null;
  readonly updatedTime: DevinDatePreset | null;
}

export const NO_DEVIN_SESSION_FILTERS: DevinSessionFilterSelection = {
  sessionType: [],
  automation: null,
  origin: [],
  status: [],
  prState: [],
  done: [],
  createdTime: null,
  updatedTime: null,
};

export function countDevinSessionFilters(selection: DevinSessionFilterSelection): number {
  return Object.values(selection).filter((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null,
  ).length;
}

/** Where Devin starts each date preset, in local time. */
export function devinDatePresetStart(preset: DevinDatePreset, now: Date): Date {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay());
  switch (preset) {
    case "today":
      return today;
    case "last_week":
      return weekStart;
    case "last_2_weeks":
      return new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7);
    case "last_month":
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
  }
}

/** Translates the menu into list parameters the way Devin's session list does. */
export function devinSessionListFilters(
  selection: DevinSessionFilterSelection,
  now: Date,
): Pick<DevinSessionListInput, "filters" | "updatedAfter"> {
  const agent = selection.sessionType.includes("agent");
  const ask = selection.sessionType.includes("ask");
  const done = selection.done.includes("done");
  const filters: DevinSessionFilters = {
    ...(agent !== ask ? { sessionType: agent ? "devin" : "ada" } : {}),
    ...(selection.automation ? { automation: selection.automation } : {}),
    ...(selection.origin.length > 0
      ? { origin: selection.origin.flatMap((origin) => ORIGIN_ALIASES[origin] ?? [origin]) }
      : {}),
    ...(selection.status.length > 0 ? { status: selection.status } : {}),
    ...(selection.prState.length > 0 ? { prState: selection.prState } : {}),
    ...(done ? { archived: selection.done.includes("notDone") ? "all" : "archived" } : {}),
    ...(selection.createdTime
      ? { createdAfter: devinDatePresetStart(selection.createdTime, now).toISOString() }
      : {}),
  };
  return {
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
    ...(selection.updatedTime
      ? { updatedAfter: devinDatePresetStart(selection.updatedTime, now).toISOString() }
      : {}),
  };
}
