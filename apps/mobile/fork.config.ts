import type { ExpoConfig } from "expo/config";

// Installed fork APKs only accept updates with this package and the fork's signing key.
const FORK_ANDROID_PACKAGE = "com.barretodiego.t3code.fork";
// expo-observe throws at startup without a project ID, which leaves the app on its splash screen.
const FORK_EAS_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

export function withForkBrand(
  config: ExpoConfig,
  env: Readonly<Record<string, string | undefined>>,
): ExpoConfig {
  if (env.T3CODE_FORK_BRAND !== "1") return config;

  const versionCode = Number(env.T3CODE_MOBILE_VERSION_CODE ?? "1");
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > MAX_ANDROID_VERSION_CODE) {
    throw new Error(
      `T3CODE_MOBILE_VERSION_CODE must be an integer between 1 and ${MAX_ANDROID_VERSION_CODE}.`,
    );
  }

  const { owner: _owner, ...rest } = config;
  const { url: _updatesUrl, ...updates } = config.updates ?? {};
  return {
    ...rest,
    name: "T3 Code Fork",
    // The fork has no EAS project, so it ships without over-the-air updates.
    updates: { ...updates, enabled: false },
    android: { ...config.android, package: FORK_ANDROID_PACKAGE, versionCode },
    plugins: [...(config.plugins ?? []), "./plugins/withForkAndroidSigning.cjs"],
    extra: {
      ...config.extra,
      eas: { ...config.extra?.eas, projectId: FORK_EAS_PROJECT_ID },
    },
  };
}
