import type {
  AutomationError,
  OrchestratorId,
  OrchestratorPermissions,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { automationError, internalCaller } from "../Caller.ts";
import * as OrchestratorService from "../OrchestratorService.ts";

/**
 * What the job service needs to know about a requester that is an
 * orchestrator: its permissions, and where the projects it may touch live.
 */
export class JobAuthority extends Context.Service<
  JobAuthority,
  {
    /** Null when no orchestrator with that id is hosted here. */
    readonly orchestratorPermissions: (
      orchestratorId: OrchestratorId,
    ) => Effect.Effect<OrchestratorPermissions | null, AutomationError>;
    /** Workspace roots, on the server's own machine, of the projects that still exist. */
    readonly projectRoots: (
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<ReadonlyArray<string>, AutomationError>;
  }
>()("t3/automation/jobs/JobAuthority") {}

/** Reads orchestrators and projects from the services that own them. Needs `OrchestratorService` and `ProjectStoreV2`. */
export const layer = Layer.effect(
  JobAuthority,
  Effect.gen(function* () {
    const orchestrators = yield* OrchestratorService.OrchestratorService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    return JobAuthority.of({
      orchestratorPermissions: (orchestratorId) =>
        Effect.map(
          orchestrators.list(internalCaller("jobs")),
          (list) => list.find((entry) => entry.id === orchestratorId)?.permissions ?? null,
        ),
      projectRoots: (projectIds) =>
        projectIds.length === 0
          ? Effect.succeed([])
          : projects.list({ projectIds }).pipe(
              Effect.map((rows) => rows.map((row) => row.workspaceRoot)),
              Effect.mapError(() =>
                automationError("INTERNAL", "Could not read the projects a job may run in."),
              ),
            ),
    });
  }),
);
