import {
  ThreadId,
  EnvironmentId,
  type OrchestrationV2ArchivedShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  applyArchivedShellStreamEvent,
  createArchivedThreadSnapshotsAtomFamily,
  makeArchivedThreadsEnvironmentKey,
  parseArchivedThreadsEnvironmentKey,
} from "./archivedThreads.ts";

it("round-trips environment keys in sorted order", () => {
  const envA = EnvironmentId.make("env-a");
  const envB = EnvironmentId.make("env-b");
  const key = makeArchivedThreadsEnvironmentKey([envB, envA]);

  expect(parseArchivedThreadsEnvironmentKey(key)).toEqual([envA, envB]);
});

it("does not expose an archived snapshot failure message", () => {
  const environmentId = EnvironmentId.make("env-sensitive");
  const snapshotsAtom = createArchivedThreadSnapshotsAtomFamily<Error>({
    getSnapshotAtom: () =>
      Atom.make(
        AsyncResult.failure<OrchestrationV2ArchivedShellSnapshot, Error>(
          Cause.fail(new Error("credential=secret-value")),
        ),
      ),
    labelPrefix: "test:archived-thread-snapshots",
  });
  const registry = AtomRegistry.make();

  expect(registry.get(snapshotsAtom(makeArchivedThreadsEnvironmentKey([environmentId])))).toEqual({
    snapshots: [],
    error: "Failed to load archived threads.",
    isLoading: false,
  });

  registry.dispose();
});

import { v2ThreadShell, v2Project, v2Now } from "./orchestrationV2TestFixtures.ts";

it("follows archive, update, restore/delete and authoritative reconnect without resurrecting stale rows", () => {
  const shell = { ...v2ThreadShell, archivedAt: v2Now };
  const seed: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 5,
    projects: [v2Project],
    threads: [],
  };
  expect(
    applyArchivedShellStreamEvent(null, { kind: "thread.updated", sequence: 6, thread: shell }),
  ).toBeNull();
  const initial = applyArchivedShellStreamEvent(null, { kind: "snapshot", snapshot: seed })!;
  const added = applyArchivedShellStreamEvent(initial, {
    kind: "thread.updated",
    sequence: 6,
    thread: shell,
  })!;
  const sibling = { ...shell, id: ThreadId.make("sibling") };
  const pair = applyArchivedShellStreamEvent(added, {
    kind: "thread.updated",
    sequence: 7,
    thread: sibling,
  })!;
  const updated = applyArchivedShellStreamEvent(pair, {
    kind: "thread.updated",
    sequence: 8,
    thread: { ...shell, title: "New title" },
  })!;
  expect(updated.threads.map((thread) => thread.id)).toEqual([shell.id, sibling.id]);
  expect(updated.threads[0]?.title).toBe("New title");
  expect(updated.threads[1]).toBe(sibling);
  expect(updated.projects).toBe(seed.projects);
  const removed = applyArchivedShellStreamEvent(updated, {
    kind: "thread.removed",
    sequence: 9,
    threadId: shell.id,
  })!;
  expect(removed.threads).toEqual([sibling]);
  for (const sequence of [8, 9]) {
    expect(
      applyArchivedShellStreamEvent(removed, { kind: "thread.updated", sequence, thread: shell }),
    ).toBe(removed);
  }
  expect(
    applyArchivedShellStreamEvent(removed, {
      kind: "snapshot",
      snapshot: { ...seed, snapshotSequence: 10 },
    })?.threads,
  ).toEqual([]);
  expect(seed.threads).toEqual([]);
});

it("reports loading only until the archive snapshot arrives and retains data on connection failure", () => {
  const env = EnvironmentId.make("env");
  const snapshot: OrchestrationV2ArchivedShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    threads: [],
  };
  const source = Atom.make<AsyncResult.AsyncResult<OrchestrationV2ArchivedShellSnapshot, Error>>(
    AsyncResult.initial(true),
  );
  const family = createArchivedThreadSnapshotsAtomFamily({
    getSnapshotAtom: () => source,
    labelPrefix: "archive-stream-test",
  });
  const registry = AtomRegistry.make();
  const aggregate = family(makeArchivedThreadsEnvironmentKey([env]));
  const unmount = registry.mount(aggregate);
  expect(registry.get(aggregate).isLoading).toBe(true);
  const success = AsyncResult.success(snapshot, { waiting: true });
  registry.set(source, success);
  expect(registry.get(aggregate)).toEqual({
    snapshots: [{ environmentId: env, snapshot }],
    error: null,
    isLoading: false,
  });
  registry.set(
    source,
    AsyncResult.failure(Cause.fail(new Error("offline")), {
      previousSuccess: Option.some(success),
    }),
  );
  expect(registry.get(aggregate)).toEqual({
    snapshots: [{ environmentId: env, snapshot }],
    error: "Failed to load archived threads.",
    isLoading: false,
  });
  unmount();
  registry.dispose();
});
