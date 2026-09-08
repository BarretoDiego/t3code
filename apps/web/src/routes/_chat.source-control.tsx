import { createFileRoute } from "@tanstack/react-router";
import { SourceControlHub } from "../components/sourceControl/SourceControlHub";
import { SidebarInset } from "../components/ui/sidebar";
export const Route = createFileRoute("/_chat/source-control")({
  validateSearch: (raw: Record<string, unknown>): { section?: "changes" | "repositories" } =>
    raw.section === "repositories" ? { section: "repositories" } : {},
  component: SourceControlRoute,
});
function SourceControlRoute() {
  const { section } = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <SourceControlHub key={section ?? "changes"} initialSection={section ?? "changes"} />
    </SidebarInset>
  );
}
