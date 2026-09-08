// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ThreadHandoffId,
  type ThreadHandoffRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { makeHandoffJournal } from "./HandoffJournal.ts";
import { assertExecutionOwner, committedOwner, transitionHandoff } from "./lifecycle.ts";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const record: ThreadHandoffRecord = {
  handoffId: ThreadHandoffId.make("handoff-1"),
  owner: { threadId: ThreadId.make("thread"), environmentId: source, generation: 0 },
  destinationEnvironmentId: destination,
  phase: "preflighting",
  revision: 0,
  createdAt: "2026-09-08T12:00:00.000Z",
  updatedAt: "2026-09-08T12:00:00.000Z",
  failure: null,
};
const phases = [
  "pausing",
  "checkpointing",
  "syncingProjects",
  "transferringSession",
  "verifying",
  "ready",
  "committed",
  "completed",
] as const;

it.effect("serializes competing destinations and retries a lost acknowledgement", () =>
  Effect.gen(function* () {
    const journal = yield* makeHandoffJournal;
    yield* journal.begin(record);
    expect(yield* journal.begin(record)).toEqual(record);
    const conflict = yield* Effect.flip(
      journal.begin({ ...record, handoffId: ThreadHandoffId.make("handoff-2") }),
    );
    expect(conflict).toMatchObject({ code: "busy" });
    const next = yield* journal.advance({
      handoffId: record.handoffId,
      expectedRevision: 0,
      phase: "pausing",
      updatedAt: record.updatedAt,
    });
    expect(
      yield* journal.advance({
        handoffId: record.handoffId,
        expectedRevision: 0,
        phase: "pausing",
        updatedAt: record.updatedAt,
      }),
    ).toEqual(next);
    expect(
      yield* Effect.flip(
        journal.advance({
          handoffId: record.handoffId,
          expectedRevision: 0,
          phase: "checkpointing",
          updatedAt: record.updatedAt,
        }),
      ),
    ).toMatchObject({ code: "conflict" });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("retains the source fence across service recreation and rejects abort after commit", () =>
  Effect.gen(function* () {
    const journal = yield* makeHandoffJournal;
    yield* journal.begin(record);
    let current = record;
    for (const phase of phases) {
      current = yield* journal.advance({
        handoffId: record.handoffId,
        expectedRevision: current.revision,
        phase,
        updatedAt: record.updatedAt,
      });
      if (phase !== "committed" && phase !== "completed") {
        expect(committedOwner(current)).toEqual(record.owner);
        expect(() =>
          assertExecutionOwner({ record: current, environmentId: source, generation: 0 }),
        ).toThrow("frozen");
        expect(() =>
          assertExecutionOwner({ record: current, environmentId: destination, generation: 1 }),
        ).toThrow("belongs");
      }
    }
    const restartedJournal = yield* makeHandoffJournal;
    const recovered = yield* restartedJournal.head(record.owner.threadId);
    expect(recovered).toEqual(current);
    expect(() =>
      assertExecutionOwner({ record: recovered!, environmentId: source, generation: 0 }),
    ).toThrow("belongs");
    expect(() =>
      assertExecutionOwner({ record: recovered!, environmentId: destination, generation: 0 }),
    ).toThrow("belongs");
    expect(() =>
      assertExecutionOwner({ record: recovered!, environmentId: destination, generation: 1 }),
    ).not.toThrow();
    expect(
      yield* Effect.flip(
        journal.advance({
          handoffId: record.handoffId,
          expectedRevision: current.revision,
          phase: "rollingBack",
          updatedAt: record.updatedAt,
          failure: "Network timeout",
        }),
      ),
    ).toMatchObject({ code: "conflict" });
    expect(
      yield* Effect.flip(
        journal.begin({ ...record, handoffId: ThreadHandoffId.make("stale-source") }),
      ),
    ).toMatchObject({ code: "notOwner" });
    const reverse = yield* journal.begin({
      ...record,
      handoffId: ThreadHandoffId.make("reverse"),
      owner: committedOwner(current),
      destinationEnvironmentId: source,
    });
    expect(reverse.owner.generation).toBe(1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

for (const failedPhase of ["preflighting", ...phases.slice(0, 6)] as const) {
  it(`preserves source ownership when ${failedPhase} fails`, () => {
    let current = record;
    for (const phase of phases) {
      if (current.phase === failedPhase) break;
      current = transitionHandoff(current, phase, current.updatedAt);
    }
    const rollingBack = transitionHandoff(
      current,
      "rollingBack",
      current.updatedAt,
      "Injected failure",
    );
    expect(() =>
      assertExecutionOwner({ record: rollingBack, environmentId: source, generation: 0 }),
    ).toThrow("frozen");
    const failed = transitionHandoff(rollingBack, "failed", current.updatedAt);
    expect(committedOwner(failed)).toEqual(record.owner);
    expect(() =>
      assertExecutionOwner({ record: failed, environmentId: source, generation: 0 }),
    ).not.toThrow();
  });
}

const incoming: ThreadHandoffRecord = {
  ...record,
  phase: "committed",
  revision: 7,
  localEnvironmentId: destination,
};
const reservation: ThreadHandoffRecord = { ...record, localEnvironmentId: destination };

it.effect("reserves before import and cancels durably without granting destination ownership", () =>
  Effect.gen(function* () {
    const journal = yield* makeHandoffJournal;
    const reserved = yield* journal.reserveIncoming(reservation);
    expect(yield* journal.reserveIncoming(reservation)).toEqual(reserved);
    expect(yield* journal.head(record.owner.threadId)).toEqual(reserved);
    expect(() =>
      assertExecutionOwner({ record: reserved, environmentId: destination, generation: 0 }),
    ).toThrow("belongs");
    expect(yield* Effect.flip(journal.begin(reservation))).toMatchObject({ code: "conflict" });
    expect(
      yield* Effect.flip(
        journal.advance({
          handoffId: record.handoffId,
          expectedRevision: 0,
          phase: "pausing",
          updatedAt: record.updatedAt,
        }),
      ),
    ).toMatchObject({ code: "notOwner" });
    const cancelled = yield* journal.rejectIncoming(record.handoffId);
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.revision).toBe(1);
    expect(committedOwner(cancelled)).toEqual(record.owner);
    expect(cancelled.localEnvironmentId).toBe(destination);
    expect(() =>
      assertExecutionOwner({ record: cancelled, environmentId: destination, generation: 0 }),
    ).toThrow("belongs");
    const restarted = yield* makeHandoffJournal;
    expect(yield* restarted.rejectIncoming(record.handoffId)).toEqual(cancelled);
    expect(yield* Effect.flip(restarted.reserveIncoming(reservation))).toMatchObject({
      code: "conflict",
    });
    expect(yield* Effect.flip(restarted.acceptIncoming(incoming))).toMatchObject({
      code: "conflict",
    });
    expect(
      yield* Effect.flip(
        restarted.begin({ ...record, handoffId: ThreadHandoffId.make("pretend-source") }),
      ),
    ).toMatchObject({ code: "notOwner" });
    const retry = yield* restarted.reserveIncoming({
      ...reservation,
      handoffId: ThreadHandoffId.make("retry"),
    });
    expect(retry.owner).toEqual(record.owner);
    // An old cancellation retry cannot change the new reservation's head.
    yield* restarted.rejectIncoming(record.handoffId);
    expect((yield* restarted.head(record.owner.threadId))?.handoffId).toBe(retry.handoffId);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("commits only the matching current reservation at a newer revision", () =>
  Effect.gen(function* () {
    const journal = yield* makeHandoffJournal;
    yield* journal.reserveIncoming(reservation);
    for (const invalid of [
      { ...incoming, revision: 0 },
      { ...incoming, owner: { ...incoming.owner, generation: 2 } },
      { ...incoming, owner: { ...incoming.owner, environmentId: EnvironmentId.make("imposter") } },
    ])
      expect(yield* Effect.flip(journal.acceptIncoming(invalid))).toMatchObject({
        code: "conflict",
      });
    expect(yield* journal.acceptIncoming(incoming)).toEqual(incoming);
    expect(yield* journal.acceptIncoming(incoming)).toEqual(incoming);
    expect(yield* Effect.flip(journal.rejectIncoming(record.handoffId))).toMatchObject({
      code: "conflict",
    });
    const completed: ThreadHandoffRecord = { ...incoming, phase: "completed", revision: 8 };
    expect(yield* journal.acceptIncoming(completed)).toEqual(completed);
    expect(yield* journal.acceptIncoming(incoming)).toEqual(completed);
    expect(
      yield* Effect.flip(
        journal.reserveIncoming({
          ...reservation,
          handoffId: ThreadHandoffId.make("overwrite-local"),
          owner: { ...record.owner, generation: 100 },
        }),
      ),
    ).toMatchObject({ code: "conflict" });
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("serializes competing incoming reservations without changing the winning owner", () =>
  Effect.gen(function* () {
    const first = yield* makeHandoffJournal;
    const second = yield* makeHandoffJournal;
    const results = yield* Effect.all(
      [
        first.reserveIncoming(reservation).pipe(Effect.exit),
        second
          .reserveIncoming({ ...reservation, handoffId: ThreadHandoffId.make("competitor") })
          .pipe(Effect.exit),
      ],
      { concurrency: "unbounded" },
    );
    expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    const winning = results.find(Exit.isSuccess);
    expect(yield* first.head(record.owner.threadId)).toEqual(winning?.value);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "reserves return handoffs with known ownership and accepts unseen intermediate generations",
  () =>
    Effect.gen(function* () {
      const journal = yield* makeHandoffJournal;
      const departure: ThreadHandoffRecord = { ...record, localEnvironmentId: source };
      yield* journal.begin(departure);
      let current = departure;
      for (const phase of phases)
        current = yield* journal.advance({
          handoffId: current.handoffId,
          expectedRevision: current.revision,
          phase,
          updatedAt: current.updatedAt,
        });
      const returned: ThreadHandoffRecord = {
        ...reservation,
        handoffId: ThreadHandoffId.make("return-reservation"),
        owner: committedOwner(current),
        localEnvironmentId: source,
        destinationEnvironmentId: source,
      };
      expect(
        yield* Effect.flip(
          journal.reserveIncoming({ ...returned, owner: { ...returned.owner, generation: 0 } }),
        ),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* Effect.flip(
          journal.reserveIncoming({
            ...returned,
            owner: { ...returned.owner, environmentId: EnvironmentId.make("unknown-source") },
          }),
        ),
      ).toMatchObject({ code: "conflict" });
      yield* journal.reserveIncoming(returned);
      yield* journal.rejectIncoming(returned.handoffId);
      const unseen = yield* journal.reserveIncoming({
        ...returned,
        handoffId: ThreadHandoffId.make("unseen-reservation"),
        owner: { ...returned.owner, environmentId: EnvironmentId.make("third"), generation: 4 },
      });
      expect(unseen.owner.generation).toBe(4);
      expect(committedOwner(unseen).environmentId).toBe("third");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "accepts incoming ownership idempotently across recreated journals and supports reverse transfer",
  () =>
    Effect.gen(function* () {
      const journal = yield* makeHandoffJournal;
      const accepted = yield* journal.acceptIncoming(incoming);
      expect(committedOwner(accepted)).toEqual({
        ...record.owner,
        environmentId: destination,
        generation: 1,
      });
      const recreated = yield* makeHandoffJournal;
      expect(yield* recreated.acceptIncoming(incoming)).toEqual(accepted);
      yield* recreated.advance({
        handoffId: incoming.handoffId,
        expectedRevision: 7,
        phase: "completed",
        updatedAt: incoming.updatedAt,
      });
      const reverse = yield* recreated.begin({
        ...record,
        handoffId: ThreadHandoffId.make("reverse"),
        localEnvironmentId: destination,
        owner: committedOwner(accepted),
        destinationEnvironmentId: source,
      });
      expect(reverse.owner.generation).toBe(1);
      expect(yield* Effect.flip(journal.acceptIncoming(incoming))).toMatchObject({
        code: "conflict",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("rejects conflicting incoming source identity and invalid local destination", () =>
  Effect.gen(function* () {
    const journal = yield* makeHandoffJournal;
    yield* journal.acceptIncoming(incoming);
    for (const invalid of [
      { ...incoming, owner: { ...incoming.owner, environmentId: EnvironmentId.make("imposter") } },
      { ...incoming, owner: { ...incoming.owner, generation: 1 } },
      { ...incoming, localEnvironmentId: source },
      { ...incoming, owner: { ...incoming.owner, environmentId: destination } },
      { ...incoming, phase: "ready" as const },
    ]) {
      expect(yield* Effect.flip(journal.acceptIncoming(invalid))).toMatchObject({
        code: "conflict",
      });
    }
    expect(yield* journal.head(record.owner.threadId)).toEqual(incoming);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "rejects stale generations and mismatched known sources but accepts missed intermediate transfers",
  () =>
    Effect.gen(function* () {
      const journal = yield* makeHandoffJournal;
      const departure: ThreadHandoffRecord = { ...record, localEnvironmentId: source };
      yield* journal.begin(departure);
      let current = departure;
      for (const phase of phases)
        current = yield* journal.advance({
          handoffId: current.handoffId,
          expectedRevision: current.revision,
          phase,
          updatedAt: current.updatedAt,
        });
      const returned: ThreadHandoffRecord = {
        ...incoming,
        handoffId: ThreadHandoffId.make("return"),
        owner: committedOwner(current),
        localEnvironmentId: source,
        destinationEnvironmentId: source,
      };
      expect(
        yield* Effect.flip(
          journal.acceptIncoming({ ...returned, owner: { ...returned.owner, generation: 0 } }),
        ),
      ).toMatchObject({ code: "conflict" });
      expect(
        yield* Effect.flip(
          journal.acceptIncoming({
            ...returned,
            owner: { ...returned.owner, environmentId: EnvironmentId.make("third") },
          }),
        ),
      ).toMatchObject({ code: "conflict" });
      const accepted = yield* journal.acceptIncoming(returned);
      expect(committedOwner(accepted).generation).toBe(2);
      yield* journal.advance({
        handoffId: accepted.handoffId,
        expectedRevision: accepted.revision,
        phase: "completed",
        updatedAt: accepted.updatedAt,
      });
      const missed = yield* journal.acceptIncoming({
        ...returned,
        handoffId: ThreadHandoffId.make("missed"),
        owner: { ...returned.owner, generation: 4, environmentId: EnvironmentId.make("third") },
      });
      expect(committedOwner(missed).generation).toBe(5);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reads ownership written by an independent database handle after an earlier miss", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-handoff-handles-"));
  const filename = NodePath.join(directory, "state.sqlite");
  const persistence = () =>
    makeSqlitePersistenceLive(filename).pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* () {
    const reader = yield* makeHandoffJournal;
    expect(yield* reader.head(record.owner.threadId)).toBeNull();
    yield* Effect.gen(function* () {
      const writer = yield* makeHandoffJournal;
      yield* writer.acceptIncoming(incoming);
      const visible = yield* reader.head(record.owner.threadId);
      expect(visible).toEqual(incoming);
      expect(() =>
        assertExecutionOwner({ record: visible!, environmentId: source, generation: 0 }),
      ).toThrow("belongs");
    }).pipe(Effect.provide(persistence()));
    const recreated = yield* makeHandoffJournal;
    expect(yield* recreated.head(record.owner.threadId)).toEqual(incoming);
  }).pipe(
    Effect.provide(persistence()),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
