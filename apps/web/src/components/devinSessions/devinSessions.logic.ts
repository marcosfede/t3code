import type { DevinSessionSummary } from "@t3tools/contracts";

interface ProjectCandidate {
  readonly workspaceRoot: string;
  readonly title: string;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function basename(path: string): string {
  return trimTrailingSlash(path).split("/").at(-1)?.toLowerCase() ?? "";
}

/**
 * Picks the project a Devin session most likely belongs to: the deepest workspace
 * containing a local session's cwd, or a project named after a cloud session's repository.
 */
export function suggestDevinSessionProject<TProject extends ProjectCandidate>(
  session: Pick<DevinSessionSummary, "kind" | "cwd" | "repositories">,
  projects: ReadonlyArray<TProject>,
): TProject | undefined {
  if (session.kind === "local") {
    if (!session.cwd) return undefined;
    const cwd = trimTrailingSlash(session.cwd);
    let best: TProject | undefined;
    for (const project of projects) {
      const root = trimTrailingSlash(project.workspaceRoot);
      if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
      if (!best || root.length > trimTrailingSlash(best.workspaceRoot).length) best = project;
    }
    return best;
  }
  const repoNames = new Set(
    session.repositories.map((repository) => repository.split("/").at(-1)?.toLowerCase()),
  );
  return projects.find(
    (project) =>
      repoNames.has(basename(project.workspaceRoot)) || repoNames.has(project.title.toLowerCase()),
  );
}
