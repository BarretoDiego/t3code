import { assert, describe, it } from "@effect/vitest";
import { CommandId, ThreadId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import { topOfPinnedOrderKey } from "@t3tools/shared/pinOrderKey";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  attachSession,
  awaitRunPrepared,
  expireRequest,
  HARNESS_MODEL,
  HARNESS_MODEL_FLAG,
  HARNESS_PROJECT_ID,
  makeCliHarness,
  runCli,
  seedApproval,
  seedQuestion,
  setLatestRunStatus,
  TerminalCloses,
} from "./testkit/CliHarness.ts";
import { threadCommand } from "./thread.ts";

const thread = (...args: ReadonlyArray<string>) => runCli(threadCommand, args);

/** Starts a thread through `t3 thread new`, the way a script would. */
const newThread = Effect.fn("test.newThread")(function* (message = "Do the work") {
  const run = yield* thread(
    "new",
    message,
    "--project",
    HARNESS_PROJECT_ID,
    "--model",
    HARNESS_MODEL_FLAG,
    "--json",
  );
  assert.equal(run.exitCode, 0);
  const threadId = ThreadId.make(run.json<{ threadId: string }>().threadId);
  yield* awaitRunPrepared(threadId);
  return threadId;
});

/** A thread with no run, as the app's "new thread" leaves it before the first message. */
const emptyThread = Effect.fn("test.emptyThread")(function* (id: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(id);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: HARNESS_PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: HARNESS_MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const shellOf = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) => threads.getThreadShell(threadId));

const requestOf = (threadId: ThreadId, requestId: string) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, ["runtimeRequests"]),
  ).pipe(
    Effect.map(({ runtimeRequests }) => runtimeRequests.find((entry) => entry.id === requestId)!),
  );

/** Every stored event of a thread so far. */
const storedEvents = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const through = yield* threads.getThreadEventSequence(threadId);
    const collected: Array<OrchestrationV2StoredEvent> = [];
    if (through === 0) return collected;
    yield* threads.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
      Stream.tap((stored) => Effect.sync(() => collected.push(stored))),
      Stream.takeUntil((stored) => stored.sequence >= through),
      Stream.runDrain,
    );
    return collected;
  });

const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(makeCliHarness()));

describe("t3 thread organization", () => {
  it.effect("settle clears the pin and reports the thread's state", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-settle");
        const pinned = yield* thread("pin", threadId, "--json");
        assert.equal(pinned.exitCode, 0);
        assert.equal(pinned.json().thread.pinned, true);
        assert.equal(pinned.json().operation, "thread.pin");
        assert.deepEqual(pinned.json().pendingApprovals, []);

        const settled = yield* thread("settle", threadId, "--json");
        assert.deepInclude(settled.json().thread, {
          id: threadId,
          settled: true,
          pinned: false,
          pinOrderKey: null,
        });
        const shell = yield* shellOf(threadId);
        assert.equal(shell?.settledOverride, "settled");
        assert.equal(shell?.pinnedAt ?? null, null);

        const unsettled = yield* thread("unsettle", threadId, "--json");
        assert.equal(unsettled.json().thread.settled, false);
        assert.equal((yield* shellOf(threadId))?.settledOverride, "active");

        const types = (yield* storedEvents(threadId)).map((stored) => stored.event.type);
        assert.deepEqual(types.slice(-3), ["thread.pinned", "thread.settled", "thread.unsettled"]);
      }),
    ),
  );

  it.effect("pin places the thread at the top of the pinned run, like the app", () =>
    provided(
      Effect.gen(function* () {
        const first = yield* emptyThread("thread-pin-a");
        const second = yield* emptyThread("thread-pin-b");
        yield* thread("pin", first);
        const firstKey = (yield* shellOf(first))?.pinOrderKey;
        assert.isString(firstKey);
        // The key the app's pin action would send for the same sidebar state.
        const expected = topOfPinnedOrderKey([{ pinnedAt: "x", pinOrderKey: firstKey }]);
        yield* thread("pin", second);
        const secondKey = (yield* shellOf(second))?.pinOrderKey;
        assert.equal(secondKey, expected);
        assert.isTrue(secondKey! < firstKey!);

        const pinEvent = (yield* storedEvents(second)).findLast(
          (stored) => stored.event.type === "thread.pinned",
        );
        assert.equal(
          pinEvent?.event.type === "thread.pinned" ? pinEvent.event.payload.pinOrderKey : null,
          expected,
        );

        yield* thread("unpin", second, "--json");
        const unpinned = yield* shellOf(second);
        assert.equal(unpinned?.pinnedAt ?? null, null);
        assert.equal(unpinned?.pinOrderKey ?? null, null);
      }),
    ),
  );

  it.effect("archive refuses a thread whose agent is working and changes nothing", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* newThread();
        yield* attachSession(threadId);
        yield* setLatestRunStatus(threadId, "running");
        const refused = yield* thread("archive", threadId, "--json");
        assert.equal(refused.exitCode, 4);
        assert.deepInclude(refused.errorJson().error, { code: "CONFLICT" });
        assert.match(refused.errorJson().error.message, /active turn/);
        assert.equal(refused.stdout.length, 0);
        assert.equal((yield* shellOf(threadId))?.archivedAt, null);

        yield* setLatestRunStatus(threadId, "completed");
        const archived = yield* thread("archive", threadId, "--json");
        assert.equal(archived.exitCode, 0);
        assert.equal(archived.json().thread.archived, true);
        assert.isNotNull((yield* shellOf(threadId))?.archivedAt);

        const restored = yield* thread("unarchive", threadId, "--json");
        assert.equal(restored.json().thread.archived, false);
      }),
    ),
  );

  it.effect("delete stops sessions and closes terminals before deleting", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-delete");
        const sessionId = yield* attachSession(threadId);
        const deleted = yield* thread("delete", threadId, "--json", "--idempotency-key", "del-1");
        assert.equal(deleted.exitCode, 0);
        assert.deepEqual(deleted.json().result, { stoppedSessions: 1 });
        assert.isNull(deleted.json().thread);
        assert.deepEqual(yield* Ref.get(yield* TerminalCloses), [
          { threadId, deleteHistory: true },
        ]);
        const types = (yield* storedEvents(threadId)).map((stored) => stored.event.type);
        assert.isBelow(types.indexOf("provider-session.detached"), types.indexOf("thread.deleted"));
        assert.isAbove(types.indexOf("provider-session.detached"), -1);
        assert.isString(sessionId);

        // The thread is gone, so only the full id and the key reach the result.
        const repeated = yield* thread("delete", threadId, "--json", "--idempotency-key", "del-1");
        assert.equal(repeated.exitCode, 0);
        assert.equal(repeated.json().sequence, deleted.json().sequence);
        assert.equal(repeated.json().replayed, true);

        const missing = yield* thread("delete", threadId, "--json");
        assert.equal(missing.exitCode, 3);
        assert.equal(missing.errorJson().error.code, "NOT_FOUND");
      }),
    ),
  );

  it.effect("stop reports how many sessions it stopped, including none", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-stop");
        const none = yield* thread("stop", threadId);
        assert.match(none.stdout.join("\n"), /no provider session to stop/);
        yield* attachSession(threadId);
        const one = yield* thread("stop", threadId, "--json");
        assert.deepEqual(one.json().result, { stoppedSessions: 1 });
      }),
    ),
  );

  it.effect("an ambiguous thread prefix is refused, and no thread is touched", () =>
    provided(
      Effect.gen(function* () {
        const first = yield* emptyThread("dup-one");
        const second = yield* emptyThread("dup-two");
        const refused = yield* thread("pin", "dup-", "--json");
        assert.equal(refused.exitCode, 4);
        assert.equal(refused.errorJson().error.code, "CONFLICT");
        assert.match(refused.errorJson().error.message, /matches 2 threads/);
        assert.equal((yield* shellOf(first))?.pinnedAt ?? null, null);
        assert.equal((yield* shellOf(second))?.pinnedAt ?? null, null);

        const unknown = yield* thread("pin", "nope", "--json");
        assert.equal(unknown.exitCode, 3);
        assert.equal(unknown.errorJson().error.code, "NOT_FOUND");
      }),
    ),
  );

  it.effect("a repeated mutation with the same key acts once", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-idem");
        const first = yield* thread(
          "rename",
          threadId,
          "First",
          "--json",
          "--idempotency-key",
          "k",
        );
        assert.equal(first.json().replayed, false);
        const second = yield* thread(
          "rename",
          threadId,
          "Second",
          "--json",
          "--idempotency-key",
          "k",
        );
        assert.equal(second.json().replayed, true);
        assert.equal(second.json().sequence, first.json().sequence);
        assert.deepEqual(second.json().commandIds, first.json().commandIds);
        assert.equal((yield* shellOf(threadId))?.title, "First");
        const renames = (yield* storedEvents(threadId)).filter(
          (stored) => stored.event.type === "thread.metadata-updated",
        );
        assert.lengthOf(renames, 1);
      }),
    ),
  );

  it.effect("list rejects a status that does not exist", () =>
    provided(
      Effect.gen(function* () {
        const exit = yield* thread("list", "--status", "runing").pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
      }),
    ),
  );
});

describe("t3 thread snooze", () => {
  it.effect("a relative snooze is counted from the server's clock", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-snooze");
        const before = DateTime.toEpochMillis(yield* DateTime.now);
        const snoozed = yield* thread("snooze", threadId, "2h", "--json");
        assert.equal(snoozed.exitCode, 0);
        const shell = yield* shellOf(threadId);
        assert.equal(DateTime.toEpochMillis(shell!.snoozedUntil!), before + 2 * 60 * 60 * 1000);
        assert.equal(snoozed.json().result.snoozedUntil, DateTime.formatIso(shell!.snoozedUntil!));
        assert.equal(snoozed.json().result.deadline, "relative");
        // The command carries the duration; the date is only a fallback.
        const event = (yield* storedEvents(threadId)).at(-1)!.event;
        assert.equal(event.type, "thread.snoozed");

        const awake = yield* thread("unsnooze", threadId, "--json");
        assert.isNull(awake.json().thread.snoozedUntil);
      }),
    ),
  );

  it.effect("an absolute deadline is stored as given, and invalid ones are refused", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-snooze-abs");
        const now = yield* DateTime.now;
        const until = DateTime.formatIso(DateTime.add(now, { days: 3 }));
        const snoozed = yield* thread("snooze", threadId, until, "--json");
        assert.equal(snoozed.json().thread.snoozedUntil, until);
        assert.equal(snoozed.json().result.deadline, "absolute");

        for (const invalid of ["soon", "2026-11-03", "2026-11-03T09:00:00", "0s"]) {
          const refused = yield* thread("snooze", threadId, invalid, "--json");
          assert.equal(refused.exitCode, 2, invalid);
          assert.equal(refused.errorJson().error.code, "INVALID_INPUT", invalid);
        }
        const past = yield* thread(
          "snooze",
          threadId,
          DateTime.formatIso(DateTime.subtract(now, { days: 1 })),
          "--json",
        );
        assert.equal(past.exitCode, 2);
        assert.equal(past.errorJson().error.code, "INVALID_INPUT");
        // Refusals left the stored deadline alone.
        assert.equal(DateTime.formatIso((yield* shellOf(threadId))!.snoozedUntil!), until);
      }),
    ),
  );

  it.effect("snoozing does not interrupt the agent or drop its run", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* newThread();
        yield* attachSession(threadId);
        const run = yield* setLatestRunStatus(threadId, "running");
        yield* thread("snooze", threadId, "1h");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { runs, providerSessions } = yield* threads.getThreadRecords(threadId, [
          "runs",
          "providerSessions",
        ]);
        assert.equal(runs.find((entry) => entry.id === run.id)?.status, "running");
        assert.isTrue(providerSessions.every((session) => session.status !== "stopped"));
        const types = (yield* storedEvents(threadId)).map((stored) => stored.event.type);
        assert.notInclude(types, "provider-session.detached");
      }),
    ),
  );
});

describe("t3 thread answer and approve", () => {
  const colors = [
    {
      id: "color",
      header: "Color",
      question: "Which color?",
      options: [
        { label: "Red", description: "Warm", value: "r" },
        { label: "Blue", description: "Cool" },
      ],
      allowCustomAnswer: false,
    },
  ];

  it.effect("show returns the full request shapes", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-show");
        const questionId = yield* seedQuestion(threadId, [
          ...colors,
          {
            id: "notes",
            header: "Notes",
            question: "Anything else?",
            options: [],
            required: false,
          },
        ]);
        const approvalId = yield* seedApproval(threadId, {
          prompt: "rm -rf build",
          options: [
            { decision: "accept", label: "Allow" },
            { decision: "decline", label: "Deny", warning: "Stops the turn" },
          ],
        });
        const shown = (yield* thread("show", threadId, "--json")).json();
        assert.deepEqual(shown.pendingUserInputs[0].questions, [
          {
            id: "color",
            header: "Color",
            question: "Which color?",
            options: [
              { label: "Red", description: "Warm", value: "r" },
              { label: "Blue", description: "Cool", value: "Blue" },
            ],
            multiSelect: false,
            allowCustomAnswer: false,
            required: true,
          },
          {
            id: "notes",
            header: "Notes",
            question: "Anything else?",
            options: [],
            multiSelect: false,
            allowCustomAnswer: true,
            required: false,
          },
        ]);
        assert.equal(shown.pendingUserInputs[0].requestId, questionId);
        assert.deepInclude(shown.pendingApprovals[0], {
          requestId: approvalId,
          requestKind: "command",
          detail: "rm -rf build",
          decisions: ["accept", "decline"],
        });
        assert.equal(shown.pendingApprovals[0].options[1].warning, "Stops the turn");
      }),
    ),
  );

  it.effect("validates answers against options, multi-select, free text and required", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-answer");
        // A live question takes structured answers; one answered by message takes text only.
        const requestId = yield* seedQuestion(
          threadId,
          [
            ...colors,
            {
              id: "tags",
              header: "Tags",
              question: "Which tags?",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
              multiSelect: true,
              allowCustomAnswer: false,
            },
            { id: "why", header: "Why", question: "Why?", options: [] },
            {
              id: "extra",
              header: "Extra",
              question: "Extra?",
              options: [],
              required: false,
            },
          ],
          { live: true },
        );
        const refused = (...answers: ReadonlyArray<string>) =>
          thread("answer", threadId, ...answers, "--json").pipe(
            Effect.map((run) => {
              assert.equal(run.exitCode, 2, answers.join(" "));
              return run.errorJson().error as { code: string; message: string };
            }),
          );
        assert.match(
          (yield* refused("color=green", "tags=A", "why=because")).message,
          /not one of its options \(r \| Blue\)/,
        );
        assert.match(
          (yield* refused("color=r", "color=Blue", "tags=A", "why=x")).message,
          /single answer/,
        );
        assert.match(
          (yield* refused("color=r", "tags=C", "why=x")).message,
          /not one of its options/,
        );
        assert.match((yield* refused("color=r", "tags=A")).message, /'why' needs an answer/);
        assert.match((yield* refused("color=r", "tags=A", "why=")).message, /cannot be empty/);
        assert.match((yield* refused("nope=1", "color=r")).message, /no question 'nope'/);
        assert.match((yield* refused("just text")).message, /4 questions/);
        assert.equal((yield* requestOf(threadId, requestId)).status, "pending");

        // The label is accepted and sent as the option's value, as the app sends it.
        const answered = yield* thread(
          "answer",
          threadId,
          "color=Red",
          "tags=A",
          "tags=B",
          "why=because it is needed",
          "--json",
        );
        assert.equal(answered.exitCode, 0);
        const stored = yield* requestOf(threadId, requestId);
        assert.equal(stored.status, "resolved");
        assert.deepEqual(stored.answers, {
          color: "r",
          tags: ["A", "B"],
          why: "because it is needed",
        });
        assert.isUndefined(stored.decision);
      }),
    ),
  );

  it.effect("refuses to pick when more than one request is pending", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-ambiguous");
        const first = yield* seedQuestion(threadId, [colors[0]!]);
        const second = yield* seedQuestion(threadId, [colors[0]!]);
        const refused = yield* thread("answer", threadId, "r", "--json");
        assert.equal(refused.exitCode, 4);
        assert.equal(refused.errorJson().error.code, "CONFLICT");
        assert.match(refused.errorJson().error.message, /2 pending questions/);
        assert.equal((yield* requestOf(threadId, first)).status, "pending");
        assert.equal((yield* requestOf(threadId, second)).status, "pending");

        const chosen = yield* thread("answer", threadId, "r", "--request", second, "--json");
        assert.equal(chosen.exitCode, 0);
        assert.equal((yield* requestOf(threadId, first)).status, "pending");
        assert.equal((yield* requestOf(threadId, second)).status, "resolved");

        const firstApproval = yield* seedApproval(threadId);
        const secondApproval = yield* seedApproval(threadId);
        const approvals = yield* thread("approve", threadId, "--json");
        assert.equal(approvals.errorJson().error.code, "CONFLICT");
        assert.equal((yield* requestOf(threadId, firstApproval)).status, "pending");
        assert.equal((yield* requestOf(threadId, secondApproval)).status, "pending");
      }),
    ),
  );

  it.effect("an answer never approves, and an approval never answers", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-kinds");
        const approvalId = yield* seedApproval(threadId);
        const questionId = yield* seedQuestion(threadId, [colors[0]!]);

        const answerApproval = yield* thread(
          "answer",
          threadId,
          "yes",
          "--request",
          approvalId,
          "--json",
        );
        assert.equal(answerApproval.exitCode, 2);
        assert.equal(answerApproval.errorJson().error.code, "INVALID_INPUT");
        assert.match(answerApproval.errorJson().error.message, /does not approve/);

        const approveQuestion = yield* thread(
          "approve",
          threadId,
          "--request",
          questionId,
          "--json",
        );
        assert.equal(approveQuestion.exitCode, 2);
        assert.match(approveQuestion.errorJson().error.message, /does not answer/);

        // The server holds the same line for a client that skips the CLI's check.
        const threads = yield* ThreadManagement.ThreadManagementService;
        const smuggledAnswer = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("smuggle-answer"),
            threadId,
            requestId: approvalId,
            answers: { any: "yes" },
          })
          .pipe(Effect.flip);
        assert.deepInclude(smuggledAnswer.cause as object, { code: "INVALID_INPUT" });
        const smuggledDecision = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make("smuggle-decision"),
            threadId,
            requestId: questionId,
            decision: "accept",
          })
          .pipe(Effect.flip);
        assert.deepInclude(smuggledDecision.cause as object, { code: "INVALID_INPUT" });

        assert.equal((yield* requestOf(threadId, approvalId)).status, "pending");
        assert.equal((yield* requestOf(threadId, questionId)).status, "pending");
      }),
    ),
  );

  it.effect("approve offers only the decisions the request advertises", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-decisions");
        const requestId = yield* seedApproval(threadId, {
          options: [
            { decision: "accept", label: "Allow" },
            { decision: "decline", label: "Deny" },
          ],
        });
        const refused = yield* thread("approve", threadId, "--decision", "acceptAlways", "--json");
        assert.equal(refused.exitCode, 2);
        assert.match(refused.errorJson().error.message, /offers: accept, decline/);
        assert.equal((yield* requestOf(threadId, requestId)).status, "pending");

        const declined = yield* thread("approve", threadId, "--decision", "decline", "--json");
        assert.equal(declined.exitCode, 0);
        assert.deepEqual(declined.json().result, { requestId, decision: "decline" });
        const stored = yield* requestOf(threadId, requestId);
        assert.equal(stored.decision, "decline");
        assert.isUndefined(stored.answers);
      }),
    ),
  );

  it.effect(
    "a resolved request keeps its first answer; the same key returns the first result",
    () =>
      provided(
        Effect.gen(function* () {
          const threadId = yield* emptyThread("thread-resolved");
          const requestId = yield* seedQuestion(threadId, [colors[0]!]);
          const first = yield* thread(
            "answer",
            threadId,
            "r",
            "--request",
            requestId,
            "--idempotency-key",
            "answer-1",
            "--json",
          );
          assert.equal(first.exitCode, 0);
          assert.equal(first.json().replayed, false);

          const repeat = yield* thread(
            "answer",
            threadId,
            "r",
            "--request",
            requestId,
            "--idempotency-key",
            "answer-1",
            "--json",
          );
          assert.equal(repeat.exitCode, 0);
          assert.equal(repeat.json().replayed, true);
          assert.equal(repeat.json().sequence, first.json().sequence);

          const late = yield* thread("answer", threadId, "Blue", "--request", requestId, "--json");
          assert.equal(late.exitCode, 4);
          assert.deepInclude(late.errorJson().error, { code: "REQUEST_ALREADY_RESOLVED" });
          assert.deepInclude(late.errorJson().error.detail, { requestId, status: "resolved" });
          assert.deepEqual((yield* requestOf(threadId, requestId)).answers, { color: "r" });

          const responses = (yield* storedEvents(threadId)).filter(
            (stored) =>
              stored.event.type === "runtime-request.updated" &&
              stored.event.payload.status === "resolved",
          );
          assert.lengthOf(responses, 1);
        }),
      ),
  );

  it.effect("an expired request is refused with its own code", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-expired");
        const approvalId = yield* seedApproval(threadId);
        yield* expireRequest(threadId, approvalId);
        const refused = yield* thread("approve", threadId, "--request", approvalId, "--json");
        assert.equal(refused.exitCode, 4);
        assert.equal(refused.errorJson().error.code, "REQUEST_EXPIRED");
        const stored = yield* requestOf(threadId, approvalId);
        assert.equal(stored.status, "expired");
        assert.isUndefined(stored.decision);

        const none = yield* thread("approve", threadId, "--json");
        assert.equal(none.exitCode, 3);
        assert.equal(none.errorJson().error.code, "NOT_FOUND");
      }),
    ),
  );
});

describe("t3 thread send, wait, and automation reads", () => {
  it.effect("--queue and --steer send the composer's delivery fields", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* newThread();
        yield* attachSession(threadId);
        yield* setLatestRunStatus(threadId, "running");
        const both = yield* thread("send", threadId, "x", "--queue", "--steer", "--json");
        assert.equal(both.exitCode, 2);

        const queued = yield* thread("send", threadId, "Next", "--queue", "--json");
        assert.equal(queued.exitCode, 0);
        assert.equal(queued.json().delivery, "queue");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
        assert.lengthOf(runs, 2);
        assert.equal(runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]?.status, "queued");
        assert.equal(runs.toSorted((a, b) => a.ordinal - b.ordinal)[0]?.status, "running");
      }),
    ),
  );

  it.effect("a wait that times out cancels nothing and exits with its own code", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* newThread();
        yield* attachSession(threadId);
        const run = yield* setLatestRunStatus(threadId, "running");
        const waiting = yield* thread("wait", threadId, "--timeout", "30s", "--json").pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("30 seconds");
        const timedOut = yield* Fiber.join(waiting);
        assert.equal(timedOut.exitCode, 8);
        assert.deepInclude(timedOut.errorJson().error, { code: "WAIT_TIMEOUT" });
        assert.deepInclude(timedOut.errorJson().error.detail, { cancelled: false });
        const threads = yield* ThreadManagement.ThreadManagementService;
        const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
        assert.equal(runs.find((entry) => entry.id === run.id)?.status, "running");
        const types = (yield* storedEvents(threadId)).map((stored) => stored.event.type);
        assert.notInclude(types, "run.interrupt-requested");
      }),
    ),
  );

  it.effect("requests reports cleanly that the server cannot list them yet", () =>
    provided(
      Effect.gen(function* () {
        const run = yield* thread("requests", "--json");
        assert.equal(run.exitCode, 7);
        assert.equal(run.errorJson().error.code, "CAPABILITY_UNSUPPORTED");
      }),
    ),
  );

  it.effect("tree lists the thread through the automation RPC", () =>
    provided(
      Effect.gen(function* () {
        const threadId = yield* emptyThread("thread-tree");
        const tree = (yield* thread("tree", threadId, "--json")).json();
        assert.deepEqual(tree.nodes, [
          {
            threadId,
            parentThreadId: null,
            title: "Thread thread-tree",
            relationship: null,
            kind: "thread",
            taskId: null,
            taskStatus: null,
            threadStatus: "idle",
            pendingRequests: 0,
            depth: 0,
          },
        ]);
      }),
    ),
  );
});
