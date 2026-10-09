import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  Constants.expoConfig?.extra?.appBrand === "fork"
    ? require("../../../../assets/fork/icon-1024.png")
    : appVariant === "development"
      ? require("../../../../assets/dev/blueprint-ios-1024.png")
      : appVariant === "preview"
        ? require("../../../../assets/nightly/nightly-ios-1024.png")
        : require("../../../../assets/prod/black-ios-1024.png");
