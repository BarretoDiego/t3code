import { createFileRoute } from "@tanstack/react-router";
import { AiRuntimesSettingsPanel } from "../components/settings/AiRuntimesSettings";
export const Route = createFileRoute("/settings/ai-runtimes")({
  component: AiRuntimesSettingsPanel,
});
