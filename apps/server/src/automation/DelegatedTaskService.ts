import type {
  AutomationError,
  DelegatedTask,
  DelegatedTaskId,
  TaskDelegateInput,
  TaskListInput,
  TaskUpdateInput,
  ThreadId,
  ThreadTreeNode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/** Delegated tasks: the contract, the managed thread that runs it, and its verified outcome. */
export class DelegatedTaskService extends Context.Service<
  DelegatedTaskService,
  {
    readonly delegate: (
      caller: AutomationCaller,
      input: TaskDelegateInput,
    ) => Effect.Effect<
      { readonly task: DelegatedTask; readonly created: boolean },
      AutomationError
    >;
    readonly get: (
      caller: AutomationCaller,
      input: DelegatedTaskId,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly list: (
      caller: AutomationCaller,
      input: TaskListInput,
    ) => Effect.Effect<ReadonlyArray<DelegatedTask>, AutomationError>;
    readonly update: (
      caller: AutomationCaller,
      input: TaskUpdateInput,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly threadTree: (
      caller: AutomationCaller,
      input: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadTreeNode>, AutomationError>;
    readonly acceptRemote: (
      caller: AutomationCaller,
      input: DelegatedTask,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
    readonly applyRemoteStatus: (
      caller: AutomationCaller,
      input: DelegatedTask,
    ) => Effect.Effect<DelegatedTask, AutomationError>;
  }
>()("t3/automation/DelegatedTaskService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(DelegatedTaskService, {
  delegate: () => Effect.fail(unsupported("DelegatedTaskService")),
  get: () => Effect.fail(unsupported("DelegatedTaskService")),
  list: () => Effect.fail(unsupported("DelegatedTaskService")),
  update: () => Effect.fail(unsupported("DelegatedTaskService")),
  threadTree: () => Effect.fail(unsupported("DelegatedTaskService")),
  acceptRemote: () => Effect.fail(unsupported("DelegatedTaskService")),
  applyRemoteStatus: () => Effect.fail(unsupported("DelegatedTaskService")),
});
