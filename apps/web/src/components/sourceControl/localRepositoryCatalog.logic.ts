import type { Project } from "../../types";

/** Uses the same project inventory as the selectors, without probing directories or remote accounts. */
export function filterLocalProjects<
  T extends Pick<Project, "title" | "workspaceRoot" | "repositoryIdentity">,
>(projects: readonly T[], query: string): readonly T[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return projects;
  return projects.filter((project) => {
    const text = [
      project.title,
      project.workspaceRoot,
      project.repositoryIdentity?.displayName,
      project.repositoryIdentity?.canonicalKey,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
