import { createFileRoute } from "@tanstack/react-router";

import { AutomationSettings } from "../components/settings/AutomationSettings";
import { validateAutomationSettingsSearch } from "../components/settings/automationSettings.logic";

function SettingsAutomationRoute() {
  const target = Route.useSearch();
  return <AutomationSettings {...target} />;
}

export const Route = createFileRoute("/settings/automation")({
  validateSearch: validateAutomationSettingsSearch,
  component: SettingsAutomationRoute,
});
