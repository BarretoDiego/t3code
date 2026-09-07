import { expect, it } from "vite-plus/test";
import { streamedReviewText as parse } from "./reviewActivityText";
const streamedReviewText = (text: string) =>
  parse(text).map(({ field, text }) => ({ field, text }));
it("shows text while a draft field is still being written", () => {
  expect(streamedReviewText('{"summary":"Reviewing concurrency')).toEqual([
    { field: "summary", text: "Reviewing concurrency" },
  ]);
});
it("decodes escaped text and does not expose unrelated structured fields", () => {
  expect(
    streamedReviewText(
      '{"reasoning":"not public","title":"Check \\"lock\\"","description":"Line\\nTwo"}'.replaceAll(
        '\\\\"',
        '\\"',
      ),
    ),
  ).toEqual([
    { field: "title", text: 'Check "lock"' },
    { field: "description", text: "Line\nTwo" },
  ]);
});
it("waits safely for partial escapes and limits the number of displayed fields", () => {
  expect(streamedReviewText('{"summary":"Hello\\u12')).toEqual([
    { field: "summary", text: "Hello" },
  ]);
  expect(
    streamedReviewText(
      Array.from({ length: 30 }, (_, i) => JSON.stringify({ title: String(i) })).join(),
    ),
  ).toHaveLength(12);
});
