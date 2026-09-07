import type { ProviderChangeRequest, ProviderListCursor } from "./PullRequestProvider.ts";

export interface ListCursor extends ProviderListCursor {
  /**
   * The rows already handed over at exactly `updatedBefore`. The next read asks for that instant
   * inclusively, so these are what keeps it from sending them a second time.
   */
  readonly seenAt: ReadonlyArray<number>;
}

/**
 * A continuation as it travels through the page and back. Written out rather than encoded because
 * it comes back from a client and has to be believed or refused on sight: everything a host is
 * given is either a timestamp of this shape or a number of this length, which is what lets a
 * provider drop it into a filter without checking it again.
 */
const LIST_CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{1,9})\|(\d{1,9}(?:,\d{1,9})*)?$/;

export function parseListCursor(raw: string): ListCursor | null {
  const match = LIST_CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const seenAt = match[3];
  return {
    updatedBefore: match[1]!,
    delivered: Number(match[2]),
    seenAt: seenAt === undefined ? [] : seenAt.split(",").map(Number),
  };
}

/**
 * How a listing tells two repositories apart. The host is part of it because the same
 * `owner/repo` exists on github.com and on an Enterprise install, and they are two repositories.
 */
export function listCursorKey(host: string, repository: string): string {
  return `${host} ${repository.toLowerCase()}`;
}

/**
 * Where a repository carries on, worked out from the slice just handed over. The boundary is the
 * instant of the oldest row in it: the next read asks for that instant and everything before it,
 * and names the rows already sent at it so none of them arrives twice.
 *
 * The names carry over when the boundary has not moved. A slice that ends on the same instant it
 * began on has to keep the earlier rows excluded as well as its own, or the read after it would
 * hand them over again.
 */
export function nextListCursor(
  previous: ListCursor | undefined,
  /** What the host handed over, before the rows already sent were dropped from it. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  /** What is being sent on, which is what the count of delivered rows is about. */
  delivered: ReadonlyArray<ProviderChangeRequest>,
  /** A provider may consume malformed offset-paged rows that never appear in `delivered`. */
  cursorAdvance = delivered.length,
): string | null {
  // The host had nothing at all, so there is no row to carry on from — and repeating the cursor
  // that produced the empty slice would ask the same question forever.
  if (fetched.length === 0) return null;
  // Taken from what the host answered rather than from what survived de-duplication: a slice can
  // be entirely rows already sent — a hundred change requests touched in the same second is one
  // repository's boring afternoon — and reading "nothing new" as "nothing left" would end the
  // walk on the instant it was stuck on, with everything older unreachable for good.
  const oldest = fetched.reduce((left, right) => (right.updatedAt < left.updatedAt ? right : left));
  return listCursorAt(previous, oldest.updatedAt, fetched, cursorAdvance);
}

/**
 * The same cursor against a boundary chosen elsewhere, which is what a slice read across several
 * repositories at once needs: every repository in it is read up to the oldest row of the whole
 * slice, including the ones that contributed nothing to it — their rows are simply all older, and
 * a repository that carried on from its own oldest row would be right about where it stopped and
 * silent about the ones that never appeared.
 */
export function listCursorAt(
  previous: ListCursor | undefined,
  boundary: string,
  /** This repository's own rows in the slice, before the ones already sent were dropped. */
  fetched: ReadonlyArray<ProviderChangeRequest>,
  deliveredCount: number,
): string {
  const seenAt = [
    ...(previous?.updatedBefore === boundary ? previous.seenAt : []),
    ...fetched.filter((item) => item.updatedAt === boundary).map((item) => item.number),
  ];
  return `${boundary}|${(previous?.delivered ?? 0) + deliveredCount}|${seenAt.join(",")}`;
}
