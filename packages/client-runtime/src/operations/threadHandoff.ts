import {
  ProjectId,
  ThreadHandoffError,
  type EnvironmentId,
  type ThreadHandoffDestination,
  type ThreadHandoffId,
  type ThreadHandoffPhase,
  type ThreadHandoffRecord,
  type ThreadHandoffRequest,
  type ThreadHandoffResponse,
  type ThreadId,
} from "@t3tools/contracts";
import {
  runProjectSync,
  type ProjectSyncDeps,
  type ProjectSyncProgress,
} from "../state/projectSync.ts";

export interface ThreadHandoffProgress {
  readonly handoffId: ThreadHandoffId;
  readonly phase: ThreadHandoffPhase;
  readonly transfer?: ProjectSyncProgress;
}
export interface ThreadHandoffDeps extends Pick<
  ProjectSyncDeps,
  "fetch" | "resolveUrl" | "maxBytesPerBatch" | "maxFilesPerBatch" | "streamingUploadSupported"
> {
  readonly request: (
    environmentId: EnvironmentId,
    input: ThreadHandoffRequest,
  ) => Promise<ThreadHandoffResponse>;
}
export interface ThreadHandoffRecoveryInput {
  readonly handoffId: ThreadHandoffId;
  readonly threadId: ThreadId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly onProgress?: (progress: ThreadHandoffProgress) => void;
}
export interface RunThreadHandoffInput extends Omit<
  ThreadHandoffRecoveryInput,
  "destinationEnvironmentId"
> {
  readonly destination: Omit<ThreadHandoffDestination, "source">;
  readonly mode: "idle" | "afterTurn" | "interrupt";
  readonly signal?: AbortSignal;
}
const error = (code: ThreadHandoffError["code"], message: string) =>
  new ThreadHandoffError({ code, message });
const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined)
    throw error("verificationFailed", `Handoff response is missing ${name}.`);
  return value;
};
const isCommitted = (record: ThreadHandoffRecord) =>
  record.phase === "committed" || record.phase === "completed";
const checkedRecord = (
  record: ThreadHandoffRecord | undefined,
  input: ThreadHandoffRecoveryInput,
) => {
  const value = required(record, "record");
  if (
    value.handoffId !== input.handoffId ||
    value.owner.threadId !== input.threadId ||
    value.owner.environmentId !== input.sourceEnvironmentId ||
    value.destinationEnvironmentId !== input.destinationEnvironmentId
  )
    throw error("verificationFailed", "Handoff response belongs to a different transfer.");
  return value;
};
const report = (
  input: ThreadHandoffRecoveryInput,
  phase: ThreadHandoffPhase,
  transfer?: ProjectSyncProgress,
) => input.onProgress?.({ handoffId: input.handoffId, phase, ...(transfer ? { transfer } : {}) });
const recoveryRequired = (input: ThreadHandoffRecoveryInput) =>
  error(
    "recoveryRequired",
    `Handoff ${input.handoffId} needs recovery. Keep source execution fenced until ownership is confirmed.`,
  );

async function status(deps: ThreadHandoffDeps, input: ThreadHandoffRecoveryInput) {
  try {
    return checkedRecord(
      (
        await deps.request(input.sourceEnvironmentId, {
          operation: "status",
          handoffId: input.handoffId,
        })
      ).record,
      input,
    );
  } catch {
    throw recoveryRequired(input);
  }
}
async function finishDestination(
  deps: ThreadHandoffDeps,
  input: ThreadHandoffRecoveryInput,
  record: ThreadHandoffRecord,
) {
  report(input, "committed");
  if (record.phase !== "completed") {
    const activated = checkedRecord(
      (await deps.request(input.destinationEnvironmentId, { operation: "activate", record }))
        .record,
      input,
    );
    if (
      !isCommitted(activated) ||
      activated.owner.generation !== record.owner.generation ||
      activated.localEnvironmentId !== input.destinationEnvironmentId
    )
      throw recoveryRequired(input);
  }
  // Completion can persist before temporary-artifact cleanup finishes.
  // Repeating complete repairs cleanup without reactivating an old departure.
  record = checkedRecord(
    (
      await deps.request(input.sourceEnvironmentId, {
        operation: "complete",
        handoffId: input.handoffId,
      })
    ).record,
    input,
  );
  if (record.phase !== "completed") throw recoveryRequired(input);
  report(input, "completed");
  return record;
}
async function beginRollback(deps: ThreadHandoffDeps, input: ThreadHandoffRecoveryInput) {
  return checkedRecord(
    (
      await deps.request(input.sourceEnvironmentId, {
        operation: "beginRollback",
        handoffId: input.handoffId,
        threadId: input.threadId,
        destinationEnvironmentId: input.destinationEnvironmentId,
      })
    ).record,
    input,
  );
}
async function rollback(
  deps: ThreadHandoffDeps,
  input: ThreadHandoffRecoveryInput,
  decision?: ThreadHandoffRecord,
) {
  // Serialize the source decision before revoking the destination. A stale
  // recovery client must never revoke a transfer another client committed.
  const fenced = decision ?? (await beginRollback(deps, input));
  if (isCommitted(fenced)) return finishDestination(deps, input, fenced);
  if (fenced.phase === "failed" || fenced.phase === "cancelled") return fenced;
  if (fenced.phase !== "rollingBack") throw recoveryRequired(input);
  report(input, "rollingBack");
  await deps.request(input.destinationEnvironmentId, {
    operation: "reject",
    handoffId: input.handoffId,
  });
  const record = checkedRecord(
    (
      await deps.request(input.sourceEnvironmentId, {
        operation: "rollback",
        handoffId: input.handoffId,
      })
    ).record,
    input,
  );
  if (record.phase !== "failed" && record.phase !== "cancelled") throw recoveryRequired(input);
  report(input, record.phase);
  return record;
}

/** Recovery follows authoritative source ownership, never the last response the
 * client happened to receive. Peers serialize status/commit/rollback per handoff. */
export async function recoverThreadHandoff(
  deps: ThreadHandoffDeps,
  input: ThreadHandoffRecoveryInput,
): Promise<ThreadHandoffRecord> {
  const record = await status(deps, input);
  try {
    if (isCommitted(record)) return await finishDestination(deps, input, record);
    if (record.phase === "failed" || record.phase === "cancelled") return record;
    return await rollback(deps, input);
  } catch {
    throw recoveryRequired(input);
  }
}

/** Uses the existing Project Sync batching and authenticated URL transport for
 * a private archive. Ownership moves only after the destination verifies it. */
export async function runThreadHandoff(
  deps: ThreadHandoffDeps,
  input: RunThreadHandoffInput,
): Promise<ThreadHandoffRecord> {
  const context: ThreadHandoffRecoveryInput = {
    ...input,
    destinationEnvironmentId: input.destination.environmentId,
  };
  if (context.sourceEnvironmentId === context.destinationEnvironmentId)
    throw error("conflict", "Choose another execution environment.");
  const checkCancellation = () => {
    if (input.signal?.aborted) throw error("transferFailed", "Transfer cancelled.");
  };
  let sourcePreparationAttempted = false;
  let commitAttempted = false;
  let committed = false;
  let rollbackDecision: Promise<ThreadHandoffRecord> | undefined;
  try {
    report(context, "preflighting");
    checkCancellation();
    const source = required(
      (
        await deps.request(input.sourceEnvironmentId, {
          operation: "inspect",
          threadId: input.threadId,
          projectIds: input.destination.projects.map((project) => project.sourceProjectId),
        })
      ).source,
      "source",
    );
    if (
      source.owner.threadId !== input.threadId ||
      source.owner.environmentId !== input.sourceEnvironmentId
    )
      throw error("notOwner", "Source no longer owns this thread.");
    const requestedDestination = { ...input.destination, source };
    const preflight = await deps.request(requestedDestination.environmentId, {
      operation: "preflight",
      destination: requestedDestination,
    });
    const verifiedDestination = preflight.destination ?? requestedDestination;
    if (
      verifiedDestination.environmentId !== requestedDestination.environmentId ||
      verifiedDestination.providerInstanceId !== requestedDestination.providerInstanceId ||
      verifiedDestination.source.owner.threadId !== source.owner.threadId ||
      verifiedDestination.source.owner.environmentId !== source.owner.environmentId ||
      verifiedDestination.source.owner.generation !== source.owner.generation ||
      verifiedDestination.source.projectId !== source.projectId ||
      verifiedDestination.source.providerInstanceId !== source.providerInstanceId ||
      verifiedDestination.source.driver !== source.driver ||
      verifiedDestination.source.version !== source.version ||
      verifiedDestination.source.sessionId !== source.sessionId ||
      verifiedDestination.projects.length !== requestedDestination.projects.length ||
      verifiedDestination.projects.some(
        (project, index) =>
          project.sourceProjectId !== requestedDestination.projects[index]?.sourceProjectId ||
          project.destinationProjectId !==
            requestedDestination.projects[index]?.destinationProjectId,
      )
    )
      throw error(
        "verificationFailed",
        "Destination preflight changed the requested transfer identity.",
      );
    const destination = {
      ...requestedDestination,
      projects: requestedDestination.projects.map((project, index) => {
        const availableHead = verifiedDestination.projects[index]?.availableHead;
        return {
          sourceProjectId: project.sourceProjectId,
          destinationProjectId: project.destinationProjectId,
          ...(availableHead ? { availableHead } : {}),
        };
      }),
    };
    checkCancellation();
    sourcePreparationAttempted = true;
    report(context, input.mode === "afterTurn" ? "preflighting" : "pausing");
    let onAbort: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        rollbackDecision ??= beginRollback(deps, context);
        void rollbackDecision.then(
          () => reject(error("transferFailed", "Transfer cancelled.")),
          () => reject(recoveryRequired(context)),
        );
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const preparation = deps.request(input.sourceEnvironmentId, {
      operation: "prepareSource",
      handoffId: input.handoffId,
      destination,
      mode: input.mode,
    });
    if (input.signal?.aborted) onAbort?.();
    const prepared = await Promise.race([preparation, cancellation]).finally(() => {
      if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    });
    checkedRecord(prepared.record, context);
    const manifest = required(prepared.manifest, "manifest");
    if (
      manifest.handoffId !== input.handoffId ||
      manifest.owner.threadId !== input.threadId ||
      manifest.owner.environmentId !== input.sourceEnvironmentId ||
      manifest.owner.generation !== source.owner.generation ||
      manifest.destinationEnvironmentId !== destination.environmentId ||
      manifest.provider.sessionId !== source.sessionId
    )
      throw error("verificationFailed", "Source manifest does not match the requested handoff.");
    checkCancellation();
    report(context, "checkpointing");
    await deps.request(destination.environmentId, {
      operation: "prepareDestination",
      manifest,
      destination,
    });
    checkCancellation();
    report(context, "syncingProjects");
    const projectId = ProjectId.make(input.handoffId);
    const url = async (environmentId: EnvironmentId, request: ThreadHandoffRequest) => {
      const response = await deps.request(environmentId, request);
      return {
        url: required(response.url, "transfer URL"),
        expiresAt: required(response.expiresAt, "transfer URL expiry"),
      };
    };
    await runProjectSync(
      {
        ...deps,
        getManifest: async (target) => ({
          workspaceRoot: "/handoff-staging",
          generatedAt: manifest.createdAt,
          entries:
            target.environmentId === input.sourceEnvironmentId
              ? manifest.files
              : required(
                  (
                    await deps.request(target.environmentId, {
                      operation: "manifest",
                      handoffId: input.handoffId,
                    })
                  ).files,
                  "destination files",
                ),
        }),
        createExportUrl: (target, entries) =>
          url(target.environmentId, { operation: "export", handoffId: input.handoffId, entries }),
        createImportUrl: (target, fileCount, totalBytes) =>
          url(target.environmentId, {
            operation: "import",
            handoffId: input.handoffId,
            fileCount,
            totalBytes,
          }),
        applyDeletions: async () => {
          throw error("conflict", "Handoff staging never deletes destination project files.");
        },
      },
      {
        source: { environmentId: input.sourceEnvironmentId, projectId },
        dest: { environmentId: destination.environmentId, projectId },
        mode: "send",
        includeGit: false,
        ...(input.signal ? { signal: input.signal } : {}),
        onProgress: (transfer) => report(context, "syncingProjects", transfer),
      },
    );
    checkCancellation();
    report(context, "verifying");
    const receipt = required(
      (
        await deps.request(destination.environmentId, {
          operation: "verify",
          handoffId: input.handoffId,
        })
      ).ready,
      "destination ready receipt",
    );
    if (
      receipt.handoffId !== input.handoffId ||
      receipt.environmentId !== destination.environmentId ||
      receipt.sessionId !== source.sessionId
    )
      throw error("verificationFailed", "Destination receipt belongs to a different handoff.");
    report(context, "ready");
    checkCancellation();
    commitAttempted = true;
    const record = checkedRecord(
      (await deps.request(input.sourceEnvironmentId, { operation: "commit", receipt })).record,
      context,
    );
    if (!isCommitted(record)) throw recoveryRequired(context);
    committed = true;
    return await finishDestination(deps, context, record);
  } catch (cause) {
    if (committed) throw recoveryRequired(context);
    if (commitAttempted) {
      const authoritative = await status(deps, context);
      if (isCommitted(authoritative)) {
        try {
          return await finishDestination(deps, context, authoritative);
        } catch {
          throw recoveryRequired(context);
        }
      }
    }
    if (sourcePreparationAttempted) {
      try {
        // An acknowledged beginRollback is a durable fence even if the
        // prepareSource acknowledgement is still in flight.
        const decision = rollbackDecision
          ? await rollbackDecision.catch(() => undefined)
          : undefined;
        const result = await rollback(deps, context, decision);
        if (result.phase === "completed") return result;
      } catch {
        throw recoveryRequired(context);
      }
    }
    throw cause;
  }
}
