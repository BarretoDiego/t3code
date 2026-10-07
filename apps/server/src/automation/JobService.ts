import type {
  AutomationError,
  ExecutionNode,
  ExecutionNodeId,
  ExecutionNodeUpsertInput,
  Job,
  JobId,
  JobLogsInput,
  JobLogsResult,
  JobSubmitInput,
  JobsListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/** Execution nodes and the traceable jobs that run on them. */
export class JobService extends Context.Service<
  JobService,
  {
    readonly listNodes: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<ExecutionNode>, AutomationError>;
    readonly upsertNode: (
      caller: AutomationCaller,
      input: ExecutionNodeUpsertInput,
    ) => Effect.Effect<ExecutionNode, AutomationError>;
    readonly removeNode: (
      caller: AutomationCaller,
      input: ExecutionNodeId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly probeNode: (
      caller: AutomationCaller,
      input: ExecutionNodeId,
    ) => Effect.Effect<ExecutionNode, AutomationError>;
    readonly submit: (
      caller: AutomationCaller,
      input: JobSubmitInput,
    ) => Effect.Effect<{ readonly job: Job; readonly created: boolean }, AutomationError>;
    readonly get: (caller: AutomationCaller, input: JobId) => Effect.Effect<Job, AutomationError>;
    readonly list: (
      caller: AutomationCaller,
      input: JobsListInput,
    ) => Effect.Effect<ReadonlyArray<Job>, AutomationError>;
    readonly cancel: (
      caller: AutomationCaller,
      input: JobId,
    ) => Effect.Effect<Job, AutomationError>;
    readonly reconcile: (
      caller: AutomationCaller,
      input: JobId,
    ) => Effect.Effect<Job, AutomationError>;
    readonly logs: (
      caller: AutomationCaller,
      input: JobLogsInput,
    ) => Effect.Effect<JobLogsResult, AutomationError>;
    readonly watch: (caller: AutomationCaller, input: JobId) => Stream.Stream<Job, AutomationError>;
  }
>()("t3/automation/JobService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(JobService, {
  listNodes: () => Effect.fail(unsupported("JobService")),
  upsertNode: () => Effect.fail(unsupported("JobService")),
  removeNode: () => Effect.fail(unsupported("JobService")),
  probeNode: () => Effect.fail(unsupported("JobService")),
  submit: () => Effect.fail(unsupported("JobService")),
  get: () => Effect.fail(unsupported("JobService")),
  list: () => Effect.fail(unsupported("JobService")),
  cancel: () => Effect.fail(unsupported("JobService")),
  reconcile: () => Effect.fail(unsupported("JobService")),
  logs: () => Effect.fail(unsupported("JobService")),
  watch: () => Stream.fail(unsupported("JobService")),
});
