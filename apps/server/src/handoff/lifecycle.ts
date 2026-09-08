import {
  ThreadHandoffError,
  type EnvironmentId,
  type ThreadExecutionOwner,
  type ThreadHandoffPhase,
  type ThreadHandoffRecord,
} from "@t3tools/contracts";

const nextPhases: Record<ThreadHandoffPhase, readonly ThreadHandoffPhase[]> = {
  preflighting: ["pausing", "rollingBack"],
  pausing: ["checkpointing", "rollingBack"],
  checkpointing: ["syncingProjects", "rollingBack"],
  syncingProjects: ["transferringSession", "rollingBack"],
  transferringSession: ["verifying", "rollingBack"],
  verifying: ["ready", "rollingBack"],
  ready: ["committed", "rollingBack"],
  committed: ["completed"],
  completed: [],
  rollingBack: ["failed", "cancelled"],
  failed: [],
  cancelled: [],
};

export function transitionHandoff(
  record: ThreadHandoffRecord,
  phase: ThreadHandoffPhase,
  updatedAt: string,
  failure: string | null = record.failure,
): ThreadHandoffRecord {
  if (!nextPhases[record.phase].includes(phase)) {
    throw new ThreadHandoffError({
      code: "conflict",
      message: `Cannot change handoff from ${record.phase} to ${phase}.`,
    });
  }
  if ((phase === "failed" || phase === "rollingBack") && !failure) {
    throw new ThreadHandoffError({ code: "conflict", message: "Rollback requires a reason." });
  }
  return { ...record, phase, revision: record.revision + 1, updatedAt, failure };
}

export function committedOwner(record: ThreadHandoffRecord): ThreadExecutionOwner {
  if (record.phase !== "committed" && record.phase !== "completed") {
    return record.owner;
  }
  return {
    threadId: record.owner.threadId,
    environmentId: record.destinationEnvironmentId,
    generation: record.owner.generation + 1,
  };
}

/** Pure fence used by command dispatch and provider startup. Retain completed
 * departures on the source: deleting them would resurrect its implicit owner. */
export function assertExecutionOwner(input: {
  readonly record: ThreadHandoffRecord;
  readonly environmentId: EnvironmentId;
  readonly generation: number;
}): void {
  const owner = committedOwner(input.record);
  if (owner.environmentId !== input.environmentId || owner.generation !== input.generation) {
    throw new ThreadHandoffError({
      code: "notOwner",
      message: `Thread execution belongs to ${owner.environmentId} at generation ${owner.generation}.`,
    });
  }
  if (
    !["preflighting", "failed", "cancelled", "committed", "completed"].includes(input.record.phase)
  ) {
    throw new ThreadHandoffError({ code: "busy", message: "Thread is frozen for handoff." });
  }
}
