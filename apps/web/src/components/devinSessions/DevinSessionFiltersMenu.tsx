import {
  CalendarIcon,
  CalendarPlusIcon,
  CircleCheckIcon,
  GlobeIcon,
  ListFilterIcon,
  LoaderIcon,
  MessageCircleIcon,
  TimerIcon,
} from "lucide-react";
import type { ElementType } from "react";

import {
  PullRequestFilterRadioSubmenu,
  type PullRequestFilterOption,
} from "../pullRequest/PullRequestListFilters";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  countDevinSessionFilters,
  DEVIN_DATE_PRESETS,
  NO_DEVIN_SESSION_FILTERS,
  type DevinDatePreset,
  type DevinOriginFilter,
  type DevinSessionFilterSelection,
} from "./devinSessions.logic";

/** MenuRadioGroup wants a string, so "unfiltered" wears one no Devin value can be. */
const ALL = "all";

interface Option<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

const ORIGIN_LABELS: Record<DevinOriginFilter, string> = {
  webapp: "Web",
  api: "API",
  cli: "CLI",
  desktop: "Desktop",
  ios: "iOS",
  automation: "Automation",
  code_scan: "Code scan",
  slack: "Slack",
  jira: "Jira",
  linear: "Linear",
  teams: "Teams",
  pylon: "Pylon",
};

const DATE_PRESET_LABELS: Record<DevinDatePreset, string> = {
  today: "Today",
  last_week: "Last week",
  last_2_weeks: "Last 2 weeks",
  last_month: "Last month",
};

function radioOptions<Value extends string>(
  Icon: ElementType<{ className?: string }>,
  options: ReadonlyArray<Option<Value>>,
): ReadonlyArray<PullRequestFilterOption<Value | typeof ALL>> {
  const all: Option<typeof ALL> = { value: ALL, label: "All" };
  return [all, ...options].map((option) => ({ ...option, Icon }));
}

const AUTOMATION_OPTIONS = radioOptions(TimerIcon, [
  { value: "automations", label: "Only automations" },
  { value: "not_automations", label: "No automations" },
]);
const DATE_OPTIONS = DEVIN_DATE_PRESETS.map((value) => ({
  value,
  label: DATE_PRESET_LABELS[value],
}));

function CheckboxSubmenu<Value extends string>({
  label,
  Icon,
  options,
  value,
  onChange,
}: {
  label: string;
  Icon: ElementType<{ className?: string }>;
  options: ReadonlyArray<Option<Value>>;
  value: ReadonlyArray<Value>;
  onChange: (value: ReadonlyArray<Value>) => void;
}) {
  const [only] = value;
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Icon aria-hidden className="size-3.5" />
        <span className="flex-1">{label}</span>
        <span className="text-xs text-muted-foreground">
          {value.length === 0
            ? "All"
            : value.length === 1
              ? options.find((option) => option.value === only)?.label
              : `${value.length} selected`}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        {options.map((option) => (
          <MenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onCheckedChange={(checked) =>
              onChange(
                checked ? [...value, option.value] : value.filter((item) => item !== option.value),
              )
            }
          >
            {option.label}
          </MenuCheckboxItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The filters of Devin's own session list that its API can apply. */
export function DevinSessionFiltersMenu({
  selection,
  onChange,
}: {
  selection: DevinSessionFilterSelection;
  onChange: (selection: DevinSessionFilterSelection) => void;
}) {
  const filterCount = countDevinSessionFilters(selection);
  const set = <Key extends keyof DevinSessionFilterSelection>(
    key: Key,
    value: DevinSessionFilterSelection[Key],
  ) => onChange({ ...selection, [key]: value });
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
        <CheckboxSubmenu
          label="Session type"
          Icon={MessageCircleIcon}
          options={[
            { value: "agent", label: "Agent" },
            { value: "ask", label: "Ask" },
          ]}
          value={selection.sessionType}
          onChange={(value) => set("sessionType", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Automation"
          value={selection.automation ?? ALL}
          options={AUTOMATION_OPTIONS}
          onChange={(value) => set("automation", value === ALL ? null : value)}
        />
        <CheckboxSubmenu
          label="Origin"
          Icon={GlobeIcon}
          options={Object.entries(ORIGIN_LABELS).map(([value, label]) => ({
            value: value as DevinOriginFilter,
            label,
          }))}
          value={selection.origin}
          onChange={(value) => set("origin", value)}
        />
        <CheckboxSubmenu
          label="Status"
          Icon={LoaderIcon}
          options={[
            { value: "running", label: "Running" },
            { value: "exit", label: "Inactive" },
          ]}
          value={selection.status}
          onChange={(value) => set("status", value)}
        />
        <CheckboxSubmenu
          label="Pull requests"
          Icon={PullRequestGlyph.pullRequest}
          options={[
            { value: "open", label: "Open" },
            { value: "draft", label: "Draft" },
            { value: "merged", label: "Merged" },
            { value: "closed", label: "Closed" },
          ]}
          value={selection.prState}
          onChange={(value) => set("prState", value)}
        />
        <CheckboxSubmenu
          label="Done"
          Icon={CircleCheckIcon}
          options={[
            { value: "done", label: "Done" },
            { value: "notDone", label: "Not done" },
          ]}
          value={selection.done}
          onChange={(value) => set("done", value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Created time"
          value={selection.createdTime ?? ALL}
          options={radioOptions(CalendarIcon, DATE_OPTIONS)}
          onChange={(value) => set("createdTime", value === ALL ? null : value)}
        />
        <PullRequestFilterRadioSubmenu
          label="Updated time"
          value={selection.updatedTime ?? ALL}
          options={radioOptions(CalendarPlusIcon, DATE_OPTIONS)}
          onChange={(value) => set("updatedTime", value === ALL ? null : value)}
        />
        {filterCount > 0 ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange(NO_DEVIN_SESSION_FILTERS)}>Clear filters</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
