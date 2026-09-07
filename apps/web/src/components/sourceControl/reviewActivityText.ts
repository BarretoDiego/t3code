/** Extract public draft fields from a streaming JSON response, including the current string. */
export function streamedReviewText(text: string): { id: number; field: string; text: string }[] {
  const fields: { id: number; field: string; text: string }[] = [];
  for (const match of text.matchAll(
    /"(summary|title|description|rationale)"\s*:\s*"((?:[^"\\]|\\.)*)("|\\?$)/g,
  )) {
    // An incomplete escape or Unicode sequence stays hidden until the next delta.
    const value = match[3] === '"' ? match[2]! : match[2]!.replace(/\\(?:u[\da-fA-F]{0,3})?$/, "");
    try {
      fields.push({ id: match.index, field: match[1]!, text: JSON.parse(`"${value}"`) as string });
    } catch {
      /* Wait for a complete string escape. */
    }
  }
  return fields.slice(-12);
}
