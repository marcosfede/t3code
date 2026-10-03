import { describe, expect, it } from "@effect/vitest";

import { suggestDevinSessionProject } from "./devinSessions.logic";

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
