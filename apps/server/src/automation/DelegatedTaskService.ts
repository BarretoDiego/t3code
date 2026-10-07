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

import type { AutomationCaller } from "./Caller.ts";
import * as EventJournal from "./EventJournal.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as PeerService from "./PeerService.ts";
import * as TaskEngine from "./tasks/TaskEngine.ts";

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

/** The service as a view of the task engine. Tests provide the engine's dependencies directly. */
export const layerFromEngine = Layer.effect(
  DelegatedTaskService,
  Effect.gen(function* () {
    const engine = yield* TaskEngine.DelegatedTaskEngine;
    return DelegatedTaskService.of({
      delegate: engine.delegate,
      get: (_caller, taskId) => engine.get(taskId),
      list: (_caller, input) => engine.list(input),
      update: engine.update,
      threadTree: (_caller, threadId) => engine.threadTree(threadId),
      acceptRemote: engine.acceptRemote,
      applyRemoteStatus: engine.applyRemoteStatus,
    });
  }),
);

/**
 * Needs, beyond its sibling automation services: `SqlClient`,
 * `ThreadManagementService`, `ThreadLaunchService`, and
 * `ServerEnvironmentIdentity`. The engine is exposed as well, so the task
 * reactor shares this instance.
 */
export const layer = layerFromEngine.pipe(
  Layer.provideMerge(TaskEngine.layer),
  Layer.provide(Layer.mergeAll(EventJournal.layer, PeerService.layer, OrchestratorService.layer)),
);
