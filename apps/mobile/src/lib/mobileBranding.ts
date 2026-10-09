export type MobileStageLabel = "Alpha" | "Dev" | "Nightly" | "Fork";

export function resolveMobileStageLabel(appVariant: unknown, appBrand?: unknown): MobileStageLabel {
  if (appBrand === "fork") return "Fork";
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Alpha";
}
