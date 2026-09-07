import type { SourceControlWorktree } from "@t3tools/contracts";

/** Parse `git worktree list --porcelain -z`, including detached and bare checkouts. */
export function parseWorktreeInventory(output: string): SourceControlWorktree[] {
  const result: SourceControlWorktree[] = [];
  let current: SourceControlWorktree | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) result.push(current);
      current = {
        path: field.slice(9),
        headSha: null,
        branch: null,
        bare: false,
        locked: false,
        prunable: false,
      };
    } else if (current) {
      if (field.startsWith("HEAD ")) current = { ...current, headSha: field.slice(5) };
      else if (field.startsWith("branch refs/heads/"))
        current = { ...current, branch: field.slice(18) };
      else if (field === "bare") current = { ...current, bare: true };
      else if (field === "locked" || field.startsWith("locked "))
        current = { ...current, locked: true };
      else if (field === "prunable" || field.startsWith("prunable "))
        current = { ...current, prunable: true };
    }
  }
  if (current) result.push(current);
  return result;
}
