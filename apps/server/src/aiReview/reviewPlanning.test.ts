import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  consolidateFindings,
  decodeReviewAnalysis,
  planReviewBatches,
  reviewComparisonBase,
} from "./reviewPlanning.ts";
const patch = (path: string, count = 1) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+line ${i} ${"x".repeat(80)}\n`).join("")}`;

describe("review context planning", () => {
  it("uses the previous reviewed head only for incremental review", () => {
    expect(reviewComparisonBase({ mode: "full", baseSha: "A", previousHeadSha: "B" })).toBe("A");
    expect(reviewComparisonBase({ mode: "incremental", baseSha: "A", previousHeadSha: "B" })).toBe(
      "B",
    );
    expect(() => reviewComparisonBase({ mode: "incremental", baseSha: "A" })).toThrow();
  });
  it("bounds Quick sampling even for a single huge hunk and reports partial coverage", () => {
    const plan = planReviewBatches(patch("source.ts", 3000), "quick", false);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches.every((batch) => batch.patch.length <= 20_000)).toBe(true);
    expect(plan.skipped).toContain("source.ts");
  });
  it("keeps every changed line and correct new-side offsets across Standard batches", () => {
    const plan = planReviewBatches(patch("source.ts", 3000), "standard", false);
    expect(plan.skipped).toEqual([]);
    const starts = plan.batches.map((batch) => Number(/@@ -0,0 \+(\d+),/.exec(batch.patch)?.[1]));
    expect(starts[0]).toBe(1);
    expect(starts.every((start, i) => i === 0 || start > starts[i - 1]!)).toBe(true);
    expect(
      plan.batches
        .map((batch) => batch.patch)
        .join("")
        .match(/^\+line /gm),
    ).toHaveLength(3000);
  });
  it("skips generated changes by default and allows explicit inclusion", () => {
    const input = patch("src/main.ts") + patch("package-lock.json");
    expect(planReviewBatches(input, "standard", false).skipped).toEqual(["package-lock.json"]);
    expect(planReviewBatches(input, "standard", true).skipped).toEqual([]);
  });
  it("deduplicates locations and retains the highest severity", () => {
    const candidate = {
      id: "1",
      title: "Race condition!",
      category: "Concurrency",
      description: "Impact",
      severity: "minor" as const,
      filePath: "a.ts",
      line: 2,
    };
    expect(
      consolidateFindings([
        candidate,
        { ...candidate, id: "2", severity: "major" },
        { ...candidate, line: 4 },
      ]).map((f) => f.severity),
    ).toEqual(["major", "minor"]);
  });
  it.effect("validates structured output and rejects invalid severity", () =>
    Effect.gen(function* () {
      const valid = '{"summary":"No findings","risk":"unknown","walkthrough":[],"findings":[]}';
      expect((yield* decodeReviewAnalysis(`\`\`\`json\n${valid}\n\`\`\``)).risk).toBe("unknown");
      const invalid =
        '{"summary":"Review","risk":"high","walkthrough":[],"findings":[{"id":"1","title":"Bug","description":"Impact","severity":"extreme"}]}';
      expect(yield* decodeReviewAnalysis(invalid).pipe(Effect.flip)).toBeDefined();
    }),
  );
});
