import { describe, expect, it } from "@effect/vitest";

import {
  devinDatePresetStart,
  devinSessionListFilters,
  NO_DEVIN_SESSION_FILTERS,
  suggestDevinSessionProject,
} from "./devinSessions.logic";

const projects = [
  { title: "Repos", workspaceRoot: "/home/me/repos" },
  { title: "t3code", workspaceRoot: "/home/me/repos/t3code/" },
  { title: "Website", workspaceRoot: "/home/me/site" },
];

describe("suggestDevinSessionProject", () => {
  it("matches cloud sessions by repository name", () => {
    expect(
      suggestDevinSessionProject({ repositories: ["marcosfede/T3Code"] }, projects)?.title,
    ).toBe("t3code");
    expect(suggestDevinSessionProject({ repositories: [] }, projects)).toBeUndefined();
  });
});

describe("devinSessionListFilters", () => {
  const now = new Date(2026, 9, 8, 15, 30);

  it("sends nothing until a filter is chosen", () => {
    expect(devinSessionListFilters(NO_DEVIN_SESSION_FILTERS, now)).toEqual({});
  });

  it("reads ticked options the way Devin does", () => {
    expect(
      devinSessionListFilters(
        {
          ...NO_DEVIN_SESSION_FILTERS,
          sessionType: ["agent", "ask"],
          origin: ["desktop", "automation", "ios"],
          status: ["running", "exit"],
          done: ["done", "notDone"],
          updatedTime: "today",
        },
        now,
      ),
    ).toEqual({
      filters: {
        origin: ["desktop", "devin_spaces", "vscode_extension", "automation", "scheduled", "ios"],
        status: ["running", "exit"],
        archived: "all",
      },
      updatedAfter: new Date(2026, 9, 8).toISOString(),
    });
    expect(
      devinSessionListFilters(
        { ...NO_DEVIN_SESSION_FILTERS, sessionType: ["ask"], done: ["done"] },
        now,
      ),
    ).toEqual({ filters: { sessionType: "ada", archived: "archived" } });
  });

  it("starts presets at Devin's boundaries", () => {
    expect(devinDatePresetStart("last_week", now)).toEqual(new Date(2026, 9, 4));
    expect(devinDatePresetStart("last_2_weeks", now)).toEqual(new Date(2026, 8, 27));
    expect(devinDatePresetStart("last_month", now)).toEqual(new Date(2026, 8, 8));
  });
});
