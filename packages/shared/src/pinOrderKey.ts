// Pinned threads carry an optional pinOrderKey (a base-26 string). The pinned
// block sorts keyed threads by plain string comparison, so placing a thread
// writes ONE key to ONE thread on that thread's own server.
export const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

/**
 * Key that sorts before every arranged pinned thread, so a fresh pin lands at
 * the top of the run. Undefined (keyless, sorts with the legacy block) when
 * key math cannot produce one: pinning must never fail on placement.
 */
export function topOfPinnedOrderKey(
  threads: Iterable<{
    readonly pinnedAt?: unknown;
    readonly pinOrderKey?: string | null | undefined;
  }>,
): string | undefined {
  let firstKey: string | null = null;
  for (const thread of threads) {
    if (thread.pinnedAt == null || thread.pinOrderKey == null) continue;
    if (firstKey === null || thread.pinOrderKey < firstKey) firstKey = thread.pinOrderKey;
  }
  return pinOrderKeyBetween(null, firstKey) ?? undefined;
}
