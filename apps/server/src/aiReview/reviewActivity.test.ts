import { describe, expect, it } from "vite-plus/test";
import { foldReviewActivity } from "./reviewActivity.ts";
import type { AiReviewActivity } from "@t3tools/contracts";
const item = (id: string, text = ""): AiReviewActivity => ({
  id,
  kind: "agent",
  label: "Reviewer",
  status: "running",
  text,
});
describe("review activity snapshots", () => {
  it("replaces streaming output without duplicating the stage or changing its order", () => {
    const rows = foldReviewActivity([item("a", "first"), item("b")], {
      ...item("a", "finished"),
      status: "completed",
    });
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(rows[0]).toMatchObject({ text: "finished", status: "completed" });
  });
  it("bounds events, labels and total text while retaining the latest output", () => {
    let rows: AiReviewActivity[] = [];
    for (let i = 0; i < 50; i++)
      rows = foldReviewActivity(rows, {
        ...item(String(i), "x".repeat(20_000)),
        label: "y".repeat(600),
      });
    expect(rows).toHaveLength(24);
    expect(rows.at(-1)?.id).toBe("49");
    expect(rows.at(-1)?.text.length).toBe(12_000);
    expect(rows.every((row) => row.label.length <= 300)).toBe(true);
    expect(rows.reduce((sum, row) => sum + row.text.length, 0)).toBe(64_000);
  });
});
