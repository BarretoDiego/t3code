import { expect, it } from "@effect/vitest";
import { reviewLinePositions, selectedDraftFindings } from "./reviewPublication.ts";

it("excludes dismissed, already published and unselected findings", () => {
  const findings = ["a", "b", "c", "d"].map((id) => ({
    id,
    title: id,
    category: "Correctness",
    description: id,
    severity: "major" as const,
  }));
  expect(
    selectedDraftFindings({
      findings,
      findingIds: ["a", "b", "c", "missing"],
      dismissedIds: ["b"],
      publishedIds: ["c"],
    }).map((f) => f.id),
  ).toEqual(["a"]);
});
it("anchors additions and context lines while refusing nonexistent or deleted new-side lines", () => {
  const patch =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,3 @@\n context\n-old\n+new\n tail\n";
  const lines = reviewLinePositions(patch).get("a.ts")!;
  expect(lines.get(10)).toEqual({ kind: "context", oldLine: 10, newLine: 10, side: "right" });
  expect(lines.get(11)).toEqual({ kind: "added", newLine: 11 });
  expect(lines.get(12)).toEqual({ kind: "context", oldLine: 12, newLine: 12, side: "right" });
  expect(lines.has(13)).toBe(false);
});
it("keeps file boundaries, renamed paths, quoted paths and later hunk offsets", () => {
  const patch =
    'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -100 +110 @@\n-c\n+d\ndiff --git a/name b/name\n--- "a/name with spaces"\n+++ "b/name with spaces"\n@@ -0,0 +1 @@\n+x\n';
  const files = reviewLinePositions(patch);
  expect(files.has("old.ts")).toBe(false);
  expect(files.get("new.ts")?.get(110)).toEqual({ kind: "added", newLine: 110 });
  expect(files.get("name with spaces")?.has(1)).toBe(true);
});
