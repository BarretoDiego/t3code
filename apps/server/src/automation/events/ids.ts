import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

const hex32 = Effect.map(Random.nextIntBetween(0, 0xffffffff), (value) =>
  value.toString(16).padStart(8, "0"),
);

/**
 * A UUID-shaped identifier drawn from the `Random` service, so a seeded test
 * gets the same ids on every run.
 */
export const randomId = Effect.map(Effect.all([hex32, hex32, hex32, hex32]), ([a, b, c, d]) =>
  [a, b.slice(0, 4), b.slice(4), c.slice(0, 4), `${c.slice(4)}${d}`].join("-"),
);
