import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { ProjectId, type TerminalEvent, type TerminalSessionSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () =>
      (options.opening
        ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void
      ).pipe(Effect.as(openSnapshot(options.history ?? ""))),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/bin/zsh" }),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  });
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { start, listeners, writes, outputLines, emit };
});

const setup = Effect.fn(function* (options: { readonly history?: string } = {}) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect("does not type into a shell that exits during startup", () =>
    Effect.gen(function* () {
      const { completion, writes, emit } = yield* setup();
      yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
      expect(yield* completion).toMatchObject({ exitCode: null });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );
});

function testSetupScript(directory?: string) {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        ...(directory ? { cwd: directory } : {}),
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(project),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe, closeIdle }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    // The command is typed once the shell goes quiet; this fake shell prints nothing.
    yield* TestClock.adjust("3 seconds");
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: directory ? `/repo-worktree/${directory}` : "/repo-worktree",
    });
    assert.equal(
      open.mock.calls[0]?.[0].cwd,
      directory ? `/repo-worktree/${directory}` : "/repo-worktree",
    );
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, " vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    // Readiness and completion observers both subscribe; every listener sees the output.
    const listener: (typeof listeners)[number] = (event) =>
      Effect.forEach([...listeners], (each) => each(event), { discard: true });
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });

    const settle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
    });
    yield* TestClock.adjust("3 seconds");
    const settleTerminalId = settle.status === "started" ? settle.terminalId : "";
    assert.match(settleTerminalId, /^settle-clean-/);
    assert.equal(write.mock.calls.at(-1)?.[0].data, " cargo clean\r");

    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    yield* TestClock.adjust("3 seconds");
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    assert.notEqual(observedTerminalId, settleTerminalId);
    const token = /__T3_SETUP_DONE___(\w+):/.exec(write.mock.calls.at(-1)?.[0].data ?? "")?.[1];
    const settleListener = listener;
    const completion = yield* Effect.forkChild(
      observedSettle.status === "started" && observedSettle.completion
        ? observedSettle.completion
        : Effect.die("no completion"),
    );
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: `\r\n__T3_SETUP_DONE___${token}:0\r\n`,
    });
    yield* Effect.yieldNow;
    assert.equal(closeIdle.mock.calls.length, 0);
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: "$ ",
    });
    assert.deepEqual((yield* Fiber.join(completion)).exitCode, 0);
    assert.deepEqual(closeIdle.mock.calls[0]?.[0], {
      threadId: "thread-1",
      terminalId: observedTerminalId,
    });
  }).pipe(Effect.provide(layer));
}

it.effect("resolves setup scripts through the standalone project service", () => testSetupScript());
it.effect("runs nested setup scripts in the corresponding worktree directory", () =>
  testSetupScript("apps/web"),
);
