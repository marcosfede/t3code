import type { DevinSessionFilters, DevinSessionOrigin } from "@t3tools/contracts";
import {
  ArchiveIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleDotIcon,
  EyeOffIcon,
  GitForkIcon,
  GlobeIcon,
  InboxIcon,
  LayersIcon,
  ListFilterIcon,
  MessageSquareIcon,
  SearchIcon,
  ShieldCheckIcon,
  TimerIcon,
} from "lucide-react";

import {
  PullRequestFilterRadioSubmenu,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

/** MenuRadioGroup wants a string, so "unfiltered" wears one no Devin value can be. */
const ANY = "any";

const STATUS_OPTIONS = [
  { value: ANY, label: "Any", Icon: LayersIcon },
  { value: "running", label: "Running", Icon: CircleDotIcon },
  { value: "finished", label: "Finished", Icon: CircleCheckIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const SESSION_TYPE_OPTIONS = [
  { value: ANY, label: "Any", Icon: LayersIcon },
  { value: "devin", label: "Devin", Icon: MessageSquareIcon },
  { value: "sub_devin", label: "Child sessions", Icon: GitForkIcon },
  { value: "ada", label: "Ask Devin", Icon: SearchIcon },
  { value: "code_scan", label: "Code scans", Icon: ShieldCheckIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const AUTOMATION_OPTIONS = [
  { value: ANY, label: "Any", Icon: LayersIcon },
  { value: "automations", label: "Automations only", Icon: TimerIcon },
  { value: "not_automations", label: "Hide automations", Icon: EyeOffIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const ORIGIN_LABELS: Record<DevinSessionOrigin, string> = {
  webapp: "Web app",
  desktop: "Desktop",
  ios: "iOS",
  cli: "CLI",
  vscode_extension: "VS Code",
  slack: "Slack",
  teams: "Teams",
  linear: "Linear",
  jira: "Jira",
  api: "API",
  scheduled: "Scheduled",
  automation: "Automation",
  code_scan: "Code scan",
  devin_spaces: "Spaces",
  pylon: "Pylon",
};

const ORIGIN_OPTIONS: ReadonlyArray<PullRequestFilterOption<string>> = [
  { value: ANY, label: "Any", Icon: LayersIcon },
  ...Object.entries(ORIGIN_LABELS).map(([value, label]) => ({ value, label, Icon: GlobeIcon })),
];

const UPDATED_OPTIONS = [
  { value: ANY, label: "Any time", Icon: LayersIcon },
  { value: "1", label: "Past 24h", Icon: CalendarClockIcon },
  { value: "7", label: "7 days", Icon: CalendarClockIcon },
  { value: "30", label: "30 days", Icon: CalendarClockIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

const ARCHIVED_OPTIONS = [
  { value: ANY, label: "Active", Icon: InboxIcon },
  { value: "archived", label: "Archived", Icon: ArchiveIcon },
  { value: "all", label: "All", Icon: LayersIcon },
] as const satisfies ReadonlyArray<PullRequestFilterOption<string>>;

/** The subset of Devin's own session filters that Devin applies server-side. */
export function DevinSessionFiltersMenu({
  filters,
  onFilters,
  updatedWithinDays,
  onUpdatedWithinDays,
}: {
  filters: DevinSessionFilters;
  onFilters: (filters: DevinSessionFilters) => void;
  updatedWithinDays: number | undefined;
  onUpdatedWithinDays: (days: number | undefined) => void;
}) {
  const filterCount = Object.keys(filters).length + (updatedWithinDays === undefined ? 0 : 1);
  const update = (key: keyof DevinSessionFilters, value: string) => {
    const { [key]: _previous, ...rest } = filters;
    onFilters(value === ANY ? rest : ({ ...rest, [key]: value } as DevinSessionFilters));
  };
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>
        <ListFilterIcon className="size-4" />
        <span>Filters</span>
        {filterCount > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {filterCount}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label="Status"
          value={filters.status ?? ANY}
          options={STATUS_OPTIONS}
          onChange={(value) => update("status", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Session type"
          value={filters.sessionType ?? ANY}
          options={SESSION_TYPE_OPTIONS}
          onChange={(value) => update("sessionType", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Automation"
          value={filters.automation ?? ANY}
          options={AUTOMATION_OPTIONS}
          onChange={(value) => update("automation", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Origin"
          value={filters.origin ?? ANY}
          options={ORIGIN_OPTIONS}
          onChange={(value) => update("origin", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Updated"
          value={updatedWithinDays === undefined ? ANY : String(updatedWithinDays)}
          options={UPDATED_OPTIONS}
          onChange={(value) => onUpdatedWithinDays(value === ANY ? undefined : Number(value))}
        />
        <PullRequestFilterRadioSubmenu
          label="Archive"
          value={filters.archived ?? ANY}
          options={ARCHIVED_OPTIONS}
          onChange={(value) => update("archived", value)}
        />
        {filterCount > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                onFilters({});
                onUpdatedWithinDays(undefined);
              }}
            >
              Clear filters
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
