import { createFileRoute } from "@tanstack/react-router";
import { AiRuntimesSettingsPanel } from "../components/settings/AiRuntimesSettings";
export const Route = createFileRoute("/_chat/settings/ai-runtimes")({
  component: AiRuntimesSettingsPanel,
});
