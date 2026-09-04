/**
 * Small errno helpers shared by the project sync filesystem paths.
 *
 * A sync walks a live working tree while an agent may be editing it, so
 * "the entry vanished" and "we may not look at it" are normal outcomes to skip
 * past rather than failures to abort the whole transfer on.
 *
 * @module projectSyncErrno
 */
import * as Predicate from "effect/Predicate";

const SKIPPABLE_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]);

export function errnoCode(cause: unknown): string | undefined {
  if (!Predicate.isObject(cause) || !("code" in cause)) return undefined;
  return Predicate.isString(cause.code) ? cause.code : undefined;
}

export function isMissingOrUnreadable(cause: unknown): boolean {
  const code = errnoCode(cause);
  return code !== undefined && SKIPPABLE_CODES.has(code);
}
