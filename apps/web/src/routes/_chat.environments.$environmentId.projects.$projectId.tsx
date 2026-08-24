import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { ProjectScopePage } from "../components/scope/ProjectScopePage";

export const Route = createFileRoute("/_chat/environments/$environmentId/projects/$projectId")({
  component: () => {
    const { environmentId, projectId } = Route.useParams();
    return (
      <ProjectScopePage
        environmentId={environmentId as EnvironmentId}
        projectId={projectId as ProjectId}
      />
    );
  },
});
