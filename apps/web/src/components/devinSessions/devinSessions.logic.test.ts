import { describe, expect, it } from "@effect/vitest";

import { suggestDevinSessionProject } from "./devinSessions.logic";

const projects = [
  { title: "Repos", workspaceRoot: "/home/me/repos" },
  { title: "t3code", workspaceRoot: "/home/me/repos/t3code/" },
  { title: "Website", workspaceRoot: "/home/me/site" },
];

describe("suggestDevinSessionProject", () => {
  it("picks the deepest workspace containing a local session's cwd", () => {
    expect(
      suggestDevinSessionProject(
        { kind: "local", cwd: "/home/me/repos/t3code/apps", repositories: [] },
        projects,
      )?.title,
    ).toBe("t3code");
    expect(
      suggestDevinSessionProject(
        { kind: "local", cwd: "/home/me/repos-old", repositories: [] },
        projects,
      ),
    ).toBeUndefined();
  });

  it("matches cloud sessions by repository name", () => {
    expect(
      suggestDevinSessionProject(
        { kind: "cloud", cwd: "/home/ubuntu", repositories: ["marcosfede/T3Code"] },
        projects,
      )?.title,
    ).toBe("t3code");
    expect(
      suggestDevinSessionProject({ kind: "cloud", cwd: null, repositories: [] }, projects),
    ).toBeUndefined();
  });
});
