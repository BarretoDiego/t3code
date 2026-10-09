import {
  EnvironmentId,
  type OrchestrationV2ArchivedShellStreamItem,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import { AsyncResult, Atom } from "effect/reactivity";

import { upsertById } from "./shellReducer.ts";

export interface ArchivedSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationV2ArchivedShellSnapshot;
}

export interface ArchivedThreadSnapshotsState {
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR = "\u001f";
const environmentIdOrder = Order.String as Order.Order<EnvironmentId>;

export function makeArchivedThreadsEnvironmentKey(
  environmentIds: ReadonlyArray<EnvironmentId>,
): string {
  return pipe(environmentIds, Arr.sort(environmentIdOrder), (sortedEnvironmentIds) =>
    sortedEnvironmentIds.join(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
  );
}

export function parseArchivedThreadsEnvironmentKey(key: string): ReadonlyArray<EnvironmentId> {
  if (key.length === 0) {
    return [];
  }
  return pipe(
    key.split(ARCHIVED_THREADS_ENVIRONMENT_KEY_SEPARATOR),
    Arr.map((environmentId) => EnvironmentId.make(environmentId)),
  );
}

export function createArchivedThreadSnapshotsAtomFamily<E>(options: {
  readonly getSnapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, E>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((environmentKey: string) =>
    Atom.make((get): ArchivedThreadSnapshotsState => {
      const snapshots: ArchivedSnapshotEntry[] = [];
      let error: string | null = null;
      let isLoading = false;

      for (const environmentId of parseArchivedThreadsEnvironmentKey(environmentKey)) {
        const result = get(options.getSnapshotAtom(environmentId));
        const snapshot = Option.getOrNull(AsyncResult.value(result));
        isLoading ||= result.waiting && snapshot === null;
        if (snapshot !== null) {
          snapshots.push({ environmentId, snapshot });
        }

        if (error === null && result._tag === "Failure") {
          error = "Failed to load archived threads.";
        }
      }

      return { snapshots, error, isLoading };
    }).pipe(Atom.withLabel(`${options.labelPrefix}:${environmentKey}`)),
  );
}

/** Folds the archive subscription; a fresh snapshot also replaces stale rows after reconnect. */
export function applyArchivedShellStreamEvent(
  snapshot: OrchestrationV2ArchivedShellSnapshot | null,
  event: OrchestrationV2ArchivedShellStreamItem,
): OrchestrationV2ArchivedShellSnapshot | null {
  if (event.kind === "snapshot") return event.snapshot;
  if (snapshot === null || event.sequence <= snapshot.snapshotSequence) return snapshot;
  const threads =
    event.kind === "thread.removed"
      ? snapshot.threads.filter((thread) => thread.id !== event.threadId)
      : upsertById(snapshot.threads, event.thread);
  return { ...snapshot, snapshotSequence: event.sequence, threads };
}
