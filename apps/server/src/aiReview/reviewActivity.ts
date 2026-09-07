import type { AiReviewActivity } from "@t3tools/contracts";

/** Keep a bounded reconnectable snapshot, rather than persisting every model token. */
export function foldReviewActivity(
  current: readonly AiReviewActivity[],
  item: AiReviewActivity,
): AiReviewActivity[] {
  const next = { ...item, text: item.text.slice(-12_000), label: item.label.slice(0, 300) };
  const found = current.some((row) => row.id === next.id);
  const rows = (
    found ? current.map((row) => (row.id === next.id ? next : row)) : [...current, next]
  ).slice(-24);
  let remaining = 64_000;
  return rows
    .toReversed()
    .map((row) => {
      const text = remaining > 0 ? row.text.slice(-remaining) : "";
      remaining -= text.length;
      return { ...row, text };
    })
    .toReversed();
}
