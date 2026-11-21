const { withAppBuildGradle } = require("expo/config-plugins");

// Release APKs must use the persistent fork key, never Expo's development key.
// Resolve secrets at Gradle execution so prebuild/config never embeds credentials.
module.exports = function withForkAndroidSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("Fork signing requires a Groovy Android app build script.");
    }
    const marker = "// T3 fork release signing";
    if (!nextConfig.modResults.contents.includes(marker)) {
      nextConfig.modResults.contents += `
${marker}
android {
    signingConfigs {
        forkRelease {
            storeFile file(providers.environmentVariable("T3CODE_ANDROID_KEYSTORE").get())
            storePassword providers.environmentVariable("T3CODE_ANDROID_STORE_PASSWORD").get()
            keyAlias providers.environmentVariable("T3CODE_ANDROID_KEY_ALIAS").get()
            keyPassword providers.environmentVariable("T3CODE_ANDROID_KEY_PASSWORD").get()
        }
    }
    buildTypes.release.signingConfig = signingConfigs.forkRelease
}
`;
    }
    return nextConfig;
  });
};
