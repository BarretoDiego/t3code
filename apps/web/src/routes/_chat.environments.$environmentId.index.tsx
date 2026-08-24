import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { EnvironmentScopePage } from "../components/scope/EnvironmentScopePage";

export const Route = createFileRoute("/_chat/environments/$environmentId/")({
  component: () => (
    <EnvironmentScopePage environmentId={Route.useParams().environmentId as EnvironmentId} />
  ),
});
