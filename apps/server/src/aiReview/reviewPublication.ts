import type { AiReviewFinding, PullRequestReviewPosition } from "@t3tools/contracts";

export function selectedDraftFindings(input: {
  findings: readonly AiReviewFinding[];
  findingIds: readonly string[];
  dismissedIds: readonly string[];
  publishedIds: readonly string[];
}): AiReviewFinding[] {
  const selected = new Set(input.findingIds);
  const excluded = new Set([...input.dismissedIds, ...input.publishedIds]);
  return input.findings.filter((finding) => selected.has(finding.id) && !excluded.has(finding.id));
}

/** Resolve a model's new-side location against the actual PR patch before publication. */
export function reviewLinePositions(
  patch: string,
): ReadonlyMap<string, ReadonlyMap<number, PullRequestReviewPosition>> {
  const files = new Map<string, Map<number, PullRequestReviewPosition>>();
  let positions: Map<number, PullRequestReviewPosition> | undefined;
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      positions = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      let path = line.slice(4);
      if (path.startsWith('"')) {
        try {
          path = JSON.parse(path) as string;
        } catch {
          continue;
        }
      }
      if (!path.startsWith("b/")) continue;
      positions = new Map();
      files.set(path.slice(2), positions);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !positions) continue;
    if (line.startsWith("+")) {
      positions.set(newLine, { kind: "added", newLine });
      newLine++;
    } else if (line.startsWith("-")) oldLine++;
    else if (line.startsWith(" ")) {
      positions.set(newLine, { kind: "context", oldLine, newLine, side: "right" });
      oldLine++;
      newLine++;
    }
  }
  return files;
}
