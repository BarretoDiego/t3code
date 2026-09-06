import { createFileRoute } from "@tanstack/react-router";

import { MiniSkillsSettingsPanel } from "../components/settings/MiniSkillsSettings";

export const Route = createFileRoute("/settings/mini-skills")({
  component: MiniSkillsSettingsPanel,
});
