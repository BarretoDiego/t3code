import { assert, it } from "@effect/vitest";

import { resolveLocalDesktopBuildArgs, resolveLocalNightlyVersion } from "./build-local-desktop.ts";

it("derives a dated local nightly version from the next stable patch", () => {
  assert.equal(
    resolveLocalNightlyVersion("0.0.33", "2026-08-25T15:07:46.000Z"),
    "0.0.34-nightly.20260825.150746",
  );
});

it("only adds a build version for local nightly builds", () => {
  const now = "2026-08-25T15:07:46.000Z";
  assert.lengthOf(resolveLocalDesktopBuildArgs(false, now), 1);
  assert.deepStrictEqual(resolveLocalDesktopBuildArgs(true, now).slice(1), [
    "--build-version",
    "0.0.34-nightly.20260825.150746",
  ]);
  assert.match(resolveLocalDesktopBuildArgs(true, now)[0]!, /build-desktop-artifact\.ts$/);
});
