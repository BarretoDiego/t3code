import { createFileRoute } from "@tanstack/react-router";

import { AgentProfilesSettingsPanel } from "../components/settings/AgentProfilesSettings";

export const Route = createFileRoute("/settings/agent-profiles")({
  component: AgentProfilesSettingsPanel,
});
