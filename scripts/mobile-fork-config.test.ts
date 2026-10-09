// @effect-diagnostics nodeBuiltinImport:off - Verify the public manifest emitted by the real Expo CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const Manifest = Schema.Struct({
  name: Schema.String,
  scheme: Schema.String,
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  android: Schema.Struct({
    package: Schema.String,
    versionCode: Schema.optional(Schema.Number),
    adaptiveIcon: Schema.Struct({ foregroundImage: Schema.String }),
  }),
  updates: Schema.Struct({ enabled: Schema.Boolean, url: Schema.optional(Schema.String) }),
  extra: Schema.Struct({
    eas: Schema.optional(Schema.Struct({ projectId: Schema.optional(Schema.String) })),
  }),
  plugins: Schema.Array(Schema.Unknown),
});

const decodeManifest = Schema.decodeUnknownSync(Manifest);

function config(fork: boolean, versionCode = "1") {
  const directory = NodeURL.fileURLToPath(new URL("../apps/mobile/", import.meta.url));
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    ["node_modules/expo/bin/cli", "config", "--type", "public", "--json"],
    {
      cwd: directory,
      env: {
        ...process.env,
        APP_VARIANT: "production",
        T3CODE_FORK_BRAND: fork ? "1" : "0",
        T3CODE_MOBILE_VERSION_CODE: versionCode,
        T3CODE_MOBILE_UPDATES_ENABLED: "1",
        T3CODE_IOS_PERSONAL_TEAM: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  return decodeManifest(JSON.parse(output));
}

describe("standalone fork Android release", () => {
  it("coexists with the store app and cannot load upstream OTA updates", async () => {
    const result = await config(true, "42");
    expect(result.name).toBe("T3 Code Fork");
    expect(result.android?.package).toBe("com.barretodiego.t3code.fork");
    expect(result.android?.versionCode).toBe(42);
    expect(result.scheme).toBe("t3code-fork");
    expect(result.updates?.enabled).toBe(false);
    expect(result.updates?.url).toBeUndefined();
    expect(result.extra?.eas?.projectId).toBeUndefined();
    expect(result.owner).toBeUndefined();
    expect(result.android?.adaptiveIcon?.foregroundImage).toContain("fork");
    expect(result.plugins).toContain("./plugins/withForkAndroidSigning.cjs");
    expect(result.plugins).toContain("./plugins/withAndroidCleartextTraffic.cjs");
  });

  it("keeps the upstream app identity and update channel when not opted in", async () => {
    const result = await config(false);
    expect(result.android?.package).toBe("com.t3tools.t3code");
    expect(result.scheme).toBe("t3code");
    expect(result.updates?.enabled).toBe(true);
    expect(result.updates?.url).toContain("d763fcb8");
    expect(result.plugins).not.toContain("./plugins/withForkAndroidSigning.cjs");
  });

  it.each(["0", "-1", "1.5", "", "not-a-number", "2100000001"])(
    "rejects invalid Android version code %j before generating native files",
    async (versionCode) => {
      expect(() => config(true, versionCode)).toThrow("T3CODE_MOBILE_VERSION_CODE");
    },
  );

  it.each(["1", "2100000000"])("accepts version code boundary %s", async (versionCode) => {
    expect((await config(true, versionCode)).android?.versionCode).toBe(Number(versionCode));
  });
});
