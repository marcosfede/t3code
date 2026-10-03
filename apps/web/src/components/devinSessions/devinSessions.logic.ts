import type { DevinSessionSummary } from "@t3tools/contracts";

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
