import type { ExpoConfig } from "expo/config";
import { expect, it } from "vite-plus/test";

import { withForkBrand } from "./fork.config.ts";

const upstream: ExpoConfig = {
  name: "T3 Code",
  slug: "t3-code",
  owner: "pingdotgg",
  updates: { enabled: true, url: "https://u.expo.dev/upstream" },
  android: { package: "com.t3tools.t3code" },
  plugins: ["./plugins/withAndroidGradleHeap.cjs"],
  extra: {
    appVariant: "production",
    eas: { projectId: "upstream", observe: { endpointUrl: "x" } },
  },
};

it("leaves upstream builds untouched", () => {
  expect(withForkBrand(upstream, {})).toBe(upstream);
});

it("keeps the identity installed fork APKs update from", () => {
  const fork = withForkBrand(upstream, {
    T3CODE_FORK_BRAND: "1",
    T3CODE_MOBILE_VERSION_CODE: "33",
  });
  expect(fork.name).toBe("T3 Code Fork");
  expect(fork.android).toEqual({ package: "com.barretodiego.t3code.fork", versionCode: 33 });
  expect(fork.updates).toEqual({ enabled: false });
  expect(fork).not.toHaveProperty("owner");
  expect(fork.plugins).toContain("./plugins/withForkAndroidSigning.cjs");
  expect(fork.extra?.eas).toEqual({
    projectId: "00000000-0000-0000-0000-000000000000",
    observe: { endpointUrl: "x" },
  });
});

it.each(["0", "1.5", "abc", "2100000001"])("rejects version code %j", (versionCode) => {
  expect(() =>
    withForkBrand(upstream, { T3CODE_FORK_BRAND: "1", T3CODE_MOBILE_VERSION_CODE: versionCode }),
  ).toThrow("T3CODE_MOBILE_VERSION_CODE must be an integer");
});
