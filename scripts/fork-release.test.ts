import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig, resolveDesktopProductName } from "./build-desktop-artifact.ts";

it.layer(NodeServices.layer)("fork release desktop build", (it) => {
  it("keeps the fork product name for stable and nightly versions", () => {
    for (const version of ["0.1.12", "0.1.12-nightly.20261121.33"]) {
      assert.equal(resolveDesktopProductName(version, true), "T3 Code Fork");
    }
    assert.equal(
      resolveDesktopProductName("0.1.12-nightly.20261121.33", false),
      "T3 Code (Nightly)",
    );
  });

  it.effect("self-signs unsigned macOS builds only when a certificate is configured", () =>
    Effect.gen(function* () {
      const afterPack = (signed: boolean, env: Record<string, string>) =>
        createBuildConfig("mac", "dmg", "1.2.3", signed, false, undefined, undefined).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
          Effect.map((config) => String(config.afterPack)),
        );
      const configured = { T3CODE_DESKTOP_MAC_SELF_SIGN_P12: "cDEy" };
      const selfSign = /scripts\/self-sign-macos\.ts$/;

      assert.match(yield* afterPack(false, configured), selfSign);
      assert.notMatch(yield* afterPack(true, configured), selfSign);
      assert.notMatch(yield* afterPack(false, {}), selfSign);
      assert.notMatch(yield* afterPack(false, { T3CODE_DESKTOP_MAC_SELF_SIGN_P12: " " }), selfSign);
    }),
  );

  it.effect("points the nightly update feed at the fork repository", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.1.12-nightly.20261121.33",
        false,
        false,
        undefined,
        undefined,
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "BarretoDiego/t3code" } }),
          ),
        ),
      );
      assert.deepStrictEqual(config.publish, [
        {
          provider: "github",
          owner: "BarretoDiego",
          repo: "t3code",
          releaseType: "prerelease",
          channel: "nightly",
        },
      ]);
    }),
  );
});
