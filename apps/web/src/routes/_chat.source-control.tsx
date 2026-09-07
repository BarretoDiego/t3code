import { createFileRoute } from "@tanstack/react-router";
import { SourceControlHub } from "../components/sourceControl/SourceControlHub";
export const Route = createFileRoute("/_chat/source-control")({
  validateSearch: (raw: Record<string, unknown>): { section?: "changes" | "repositories" } =>
    raw.section === "repositories" ? { section: "repositories" } : {},
  component: SourceControlRoute,
});
function SourceControlRoute() {
  const { section } = Route.useSearch();
  return <SourceControlHub key={section ?? "changes"} initialSection={section ?? "changes"} />;
}
