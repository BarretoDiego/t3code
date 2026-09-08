import { assert, it } from "@effect/vitest";
import desktopPackage from "../apps/desktop/package.json" with { type: "json" };

import { resolveLocalDesktopBuildArgs, resolveLocalNightlyVersion } from "./build-local-desktop.ts";

it("derives a dated local nightly version from the next stable patch", () => {
  assert.equal(
    resolveLocalNightlyVersion("0.0.33", "2026-08-25T15:07:46.000Z"),
    "0.0.34-nightly.20260825.150746",
  );
});

it("normalizes early-morning and midnight builds to valid numeric prerelease identifiers", () => {
  assert.equal(
    resolveLocalNightlyVersion("0.0.39", "2026-09-08T00:07:37.000Z"),
    "0.0.40-nightly.20260908.737",
  );
  assert.equal(
    resolveLocalNightlyVersion("0.0.39", "2026-09-08T00:00:00.000Z"),
    "0.0.40-nightly.20260908.0",
  );
  assert.equal(
    resolveLocalNightlyVersion("0.0.39", "2026-09-08T09:05:03.000Z"),
    "0.0.40-nightly.20260908.90503",
  );
});

it("only adds a build version for local nightly builds", () => {
  const now = "2026-08-25T15:07:46.000Z";
  assert.lengthOf(resolveLocalDesktopBuildArgs(false, now), 1);
  assert.deepStrictEqual(resolveLocalDesktopBuildArgs(true, now).slice(1), [
    "--build-version",
    resolveLocalNightlyVersion(desktopPackage.version, now),
  ]);
  assert.match(resolveLocalDesktopBuildArgs(true, now)[0]!, /build-desktop-artifact\.ts$/);
});
