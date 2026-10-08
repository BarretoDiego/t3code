/**
 * `t3 schedule` - recurring tasks in the app scheduler.
 *
 * The same scheduler the settings screens and the agents' `schedule_task` tool
 * use: a task either posts into one thread on every run, or starts a new
 * thread in a project each time.
 */
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type OrchestrationV2ShellSnapshot,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskUpsertSchedule,
  WS_METHODS,
} from "@t3tools/contracts";
import { HostProcessWorkingDirectory } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { jsonFlag, printJson, withClient } from "./common.ts";
import { DurationFromString } from "./config.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import {
  CLI_PROVENANCE,
  formatModel,
  interactionModeFlag,
  loadShell,
  modelFlag,
  parseModelSelection,
  readMessage,
  resolveNewThreadDefaults,
  resolveProject,
  resolveThread,
  runtimeModeFlag,
} from "./thread.ts";

export class ScheduleCliError extends Schema.TaggedError<ScheduleCliError>()("ScheduleCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new ScheduleCliError({ detail }));

// ---------------------------------------------------------------------------
// Schedules

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const TIME_OF_DAY_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function weekdayIndex(value: string): number | null {
  const index = /^[0-6]$/.test(value)
    ? Number(value)
    : WEEKDAY_NAMES.indexOf(value.slice(0, 3) as (typeof WEEKDAY_NAMES)[number]);
  return index >= 0 && value.length >= 1 ? index : null;
}

/**
 * Reads `--days`: names or numbers (0 is Sunday), lists and ranges, plus
 * `weekdays`, `weekends`, and `daily`. Returns null for anything else, and an
 * empty list for "every day".
 */
export function parseWeekdays(input: string): ReadonlyArray<number> | null {
  const text = input.trim().toLowerCase();
  if (text === "daily" || text === "everyday" || text === "all") return [];
  if (text === "weekdays") return [1, 2, 3, 4, 5];
  if (text === "weekends") return [0, 6];
  const days = new Set<number>();
  for (const part of text.split(",").map((entry) => entry.trim())) {
    const [from, to, ...rest] = part.split("-").map((entry) => entry.trim());
    const start = from === undefined ? null : weekdayIndex(from);
    const end = to === undefined ? start : weekdayIndex(to);
    if (start === null || end === null || rest.length > 0) return null;
    // A range may wrap the week, so fri-mon is Fri, Sat, Sun, Mon.
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return days.size === 7 ? [] : [...days].toSorted((left, right) => left - right);
}

function formatInterval(everyMs: number): string {
  const units = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const;
  const [suffix, size] = units.find(([, unit]) => everyMs % unit === 0) ?? ["ms", 1];
  return `${everyMs / size}${suffix}`;
}

/** A schedule in the words a person would use, e.g. "every 2h" or "Mon, Wed at 09:00". */
export function describeSchedule(schedule: ScheduledTask["schedule"]): string {
  if (schedule.type === "interval") return `every ${formatInterval(schedule.everyMs)}`;
  if (schedule.type === "webhook") return "on webhook";
  const days = schedule.weekdays ?? [];
  const when =
    days.length === 0 || days.length === 7
      ? "daily"
      : days.join() === "1,2,3,4,5"
        ? "weekdays"
        : days.join() === "0,6"
          ? "weekends"
          : days.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${when} at ${schedule.timeOfDay}`;
}

interface ScheduleFlags {
  readonly every: Option.Option<Duration.Duration>;
  readonly at: Option.Option<string>;
  readonly days: Option.Option<string>;
}

/** The schedule the flags describe, or none when the command passed no schedule flag. */
const scheduleFromFlags = Effect.fn("cli.schedule.fromFlags")(function* (flags: ScheduleFlags) {
  if (Option.isSome(flags.every)) {
    if (Option.isSome(flags.at) || Option.isSome(flags.days)) {
      return yield* fail("Use either --every, or --at with optional --days.");
    }
    const everyMs = Duration.toMillis(flags.every.value);
    if (everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS) {
      return yield* fail("The shortest interval is one minute.");
    }
    return Option.some<ScheduledTaskUpsertSchedule>({ type: "interval", everyMs });
  }
  if (Option.isNone(flags.at)) {
    return Option.isSome(flags.days)
      ? yield* fail("--days needs a time: add --at HH:MM.")
      : Option.none<ScheduledTaskUpsertSchedule>();
  }
  const timeOfDay = flags.at.value.trim();
  if (!TIME_OF_DAY_PATTERN.test(timeOfDay)) {
    return yield* fail("Use --at with a 24-hour time such as 09:00 or 18:30.");
  }
  const weekdays = Option.isSome(flags.days) ? parseWeekdays(flags.days.value) : [];
  if (weekdays === null) {
    return yield* fail(
      "Use --days with names or numbers, for example mon-fri, sat,sun, weekdays, or 1,3,5.",
    );
  }
  return Option.some<ScheduledTaskUpsertSchedule>({
    type: "fixed_time",
    timeOfDay,
    ...(weekdays.length === 0 ? {} : { weekdays: [...weekdays] }),
  });
});

const scheduleFlags = {
  every: Flag.String("every").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Run on an interval, e.g. 30m, 2h, 1d. At least one minute."),
    Flag.optional,
  ),
  at: Flag.String("at").pipe(
    Flag.withDescription("Run at this time of day (24-hour HH:MM) in the environment's time zone."),
    Flag.optional,
  ),
  days: Flag.String("days").pipe(
    Flag.withDescription(
      "With --at: the days to run, e.g. mon-fri, sat,sun, weekdays. Default: every day.",
    ),
    Flag.optional,
  ),
} as const;

// ---------------------------------------------------------------------------
// Where a task runs

interface WorkspaceFlags {
  readonly worktree: Option.Option<string>;
  readonly root: boolean;
}

const workspaceFlags = {
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "For tasks that start a new thread: branch each run's worktree from this base branch. Default: main.",
    ),
    Flag.optional,
  ),
  root: Flag.Boolean("root").pipe(
    Flag.withDescription(
      "For tasks that start a new thread: run in the project folder instead of a worktree.",
    ),
    Flag.withDefault(false),
  ),
} as const;

/**
 * The workspace of a task that starts a new thread on every run. It defaults
 * to a fresh worktree so unattended runs do not edit the project's checkout.
 */
const newThreadWorkspace = Effect.fn("cli.schedule.newThreadWorkspace")(function* (
  flags: WorkspaceFlags,
) {
  if (flags.root && Option.isSome(flags.worktree)) {
    return yield* fail("Use either --root or --worktree.");
  }
  return flags.root
    ? ({ type: "root" } as const)
    : ({
        type: "worktree",
        baseRef: Option.getOrElse(flags.worktree, () => "main"),
        startFromOrigin: true,
      } as const);
});

// ---------------------------------------------------------------------------
// Tasks

const loadTasks = (client: EnvironmentRpcClient) =>
  Effect.map(client[WS_METHODS.scheduledTasksList]({}), (result) => result.tasks);

/** Resolves a task by id, unique id prefix, or exact title. */
const resolveTask = Effect.fn("cli.schedule.resolveTask")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const wanted = identifier.trim();
  const tasks = yield* loadTasks(client);
  const exact = tasks.filter((task) => task.id === wanted);
  // Ids read `scheduled-task:<uuid>`; the uuid alone, or its start, is enough.
  const byPrefix =
    wanted.length === 0
      ? []
      : tasks.filter(
          (task) => task.id.startsWith(wanted) || task.id.split(":").at(-1)?.startsWith(wanted),
        );
  const byTitle = tasks.filter((task) => task.title.toLowerCase() === wanted.toLowerCase());
  const matches = [exact, byPrefix, byTitle].find((candidates) => candidates.length > 0) ?? [];
  if (matches.length === 1) return matches[0]!;
  return yield* fail(
    matches.length === 0
      ? `No scheduled task matches '${wanted}'. Run \`t3 schedule list\` to see them.`
      : `'${wanted}' matches ${matches.length} scheduled tasks: ${matches.map((task) => task.id).join(", ")}. Use its id.`,
  );
});

function taskTarget(task: ScheduledTask, shell: OrchestrationV2ShellSnapshot): string {
  if (task.threadId !== null) return `thread ${task.threadId}`;
  const project = shell.projects.find((entry) => entry.id === task.projectId);
  const workspace =
    task.workspaceStrategy.type === "worktree"
      ? `a worktree from ${task.workspaceStrategy.baseRef}`
      : task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "the project folder";
  return `a new thread in ${project?.title ?? task.projectId}, in ${workspace}`;
}

function formatTaskLine(task: ScheduledTask): string {
  return [
    task.id,
    task.enabled ? "enabled" : "paused",
    describeSchedule(task.schedule),
    `next ${task.enabled ? (task.nextRunAt ?? "-") : "-"}`,
    `last ${task.lastRunStatus}`,
    task.title,
  ].join("  ");
}

function formatTaskDetail(task: ScheduledTask, shell: OrchestrationV2ShellSnapshot): string {
  return [
    `${task.title}  (${task.id})`,
    `  state:    ${task.enabled ? "enabled" : "paused"}`,
    `  schedule: ${describeSchedule(task.schedule)}`,
    `  runs in:  ${taskTarget(task, shell)}`,
    `  model:    ${formatModel(task.modelSelection)}  (${task.runtimeMode}, ${task.interactionMode})`,
    `  next run: ${task.enabled ? (task.nextRunAt ?? "-") : "paused"}`,
    task.lastRunAt === null
      ? "  last run: never"
      : `  last run: ${task.lastRunAt}  ${task.lastRunStatus}  (${task.runCount} run${task.runCount === 1 ? "" : "s"})`,
    ...(task.lastRunError === null ? [] : [`  error:    ${task.lastRunError}`]),
    "",
    task.prompt,
  ].join("\n");
}

const printTask = (
  client: EnvironmentRpcClient,
  task: ScheduledTask,
  json: boolean,
  headline?: string,
) =>
  Effect.gen(function* () {
    if (json) return yield* printJson(task);
    const shell = yield* loadShell(client);
    yield* Console.log(
      [...(headline === undefined ? [] : [headline, ""]), formatTaskDetail(task, shell)].join("\n"),
    );
  });

const taskArgument = Argument.String("task").pipe(
  Argument.withDescription("Scheduled task id, unique id prefix, or exact title."),
);

const titleFromPrompt = (prompt: string) =>
  prompt.split("\n")[0]?.trim().slice(0, 80) || "Scheduled task";

// ---------------------------------------------------------------------------
// Commands

const listCommand = Command.make("list", {
  ...environmentTargetFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Only tasks of this project (id, path, or title)."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List scheduled tasks with their schedule, next run, and last result."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.list")(function* (client, flags) {
        const all = yield* loadTasks(client);
        const projectId = Option.isSome(flags.project)
          ? (yield* resolveProject(yield* loadShell(client), flags.project.value)).id
          : null;
        const tasks = projectId === null ? all : all.filter((task) => task.projectId === projectId);
        if (flags.json) return yield* printJson(tasks);
        yield* Console.log(
          tasks.length === 0 ? "No scheduled tasks." : tasks.map(formatTaskLine).join("\n"),
        );
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...environmentTargetFlags,
  task: taskArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show one scheduled task in full, including its prompt and last error."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.show")(function* (client, flags) {
        yield* printTask(client, yield* resolveTask(client, flags.task), flags.json);
      }),
    ),
  ),
);

const addCommand = Command.make("add", {
  ...environmentTargetFlags,
  prompt: Argument.String("prompt").pipe(
    Argument.withDescription("What the agent should do on each run. Omit or pass - for stdin."),
    Argument.variadic(),
  ),
  ...scheduleFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription(
      "Post every run into this thread. Default: start a new thread in the project each run.",
    ),
    Flag.optional,
  ),
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id, path, or title. Default: the project containing the cwd."),
    Flag.optional,
  ),
  ...workspaceFlags,
  title: Flag.String("title").pipe(
    Flag.withDescription("Task title. Default: the first line of the prompt."),
    Flag.optional,
  ),
  model: modelFlag,
  runtimeMode: runtimeModeFlag,
  mode: interactionModeFlag,
  paused: Flag.Boolean("paused").pipe(
    Flag.withDescription("Create the task without starting its schedule."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Schedule a recurring task: --every <interval>, or --at <HH:MM>."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.add")(function* (client, flags) {
        const schedule = yield* scheduleFromFlags(flags);
        if (Option.isNone(schedule)) {
          return yield* fail("Say when it runs: --every 1h, or --at 09:00 [--days mon-fri].");
        }
        const prompt = yield* readMessage(flags.prompt);
        const common = {
          title: Option.getOrElse(flags.title, () => titleFromPrompt(prompt)),
          prompt,
          enabled: !flags.paused,
          schedule: schedule.value,
          interactionMode: Option.getOrElse(flags.mode, () => "default" as const),
          ...CLI_PROVENANCE,
        };

        let input: ScheduledTaskUpsertInput;
        if (Option.isSome(flags.thread)) {
          if (Option.isSome(flags.project) || flags.root || Option.isSome(flags.worktree)) {
            return yield* fail(
              "--thread already decides where the task runs; drop --project, --root, and --worktree.",
            );
          }
          // A bound task continues the thread, so it inherits the thread's model and modes.
          const { thread } = yield* resolveThread(client, flags.thread.value);
          input = {
            ...common,
            projectId: thread.projectId,
            threadId: thread.id,
            workspaceStrategy: { type: "root" },
            modelSelection: Option.isSome(flags.model)
              ? yield* parseModelSelection(flags.model.value, thread.modelSelection.instanceId)
              : thread.modelSelection,
            runtimeMode: Option.getOrElse(flags.runtimeMode, () => thread.runtimeMode),
            interactionMode: Option.getOrElse(flags.mode, () => thread.interactionMode),
          };
        } else {
          const shell = yield* loadShell(client);
          const project = yield* resolveProject(
            shell,
            Option.isSome(flags.project) ? flags.project.value : yield* HostProcessWorkingDirectory,
          );
          const defaults = yield* resolveNewThreadDefaults(client, shell, project, flags.model);
          input = {
            ...common,
            projectId: project.id,
            threadId: null,
            workspaceStrategy: yield* newThreadWorkspace(flags),
            modelSelection: defaults.modelSelection,
            runtimeMode: Option.getOrElse(flags.runtimeMode, () => defaults.runtimeMode),
          };
        }
        const { task } = yield* client[WS_METHODS.scheduledTasksUpsert](input);
        yield* printTask(client, task, flags.json, `Scheduled ${task.id}.`);
      }),
    ),
  ),
);

const editCommand = Command.make("edit", {
  ...environmentTargetFlags,
  task: taskArgument,
  prompt: Flag.String("prompt").pipe(
    Flag.withDescription("New prompt. Pass - to read it from stdin."),
    Flag.optional,
  ),
  title: Flag.String("title").pipe(Flag.withDescription("New title."), Flag.optional),
  ...scheduleFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Post every run into this thread from now on."),
    Flag.optional,
  ),
  newThread: Flag.Boolean("new-thread").pipe(
    Flag.withDescription("Start a new thread on every run from now on."),
    Flag.withDefault(false),
  ),
  ...workspaceFlags,
  model: modelFlag,
  runtimeMode: runtimeModeFlag,
  mode: interactionModeFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Change a scheduled task. Only the flags you pass change."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.edit")(function* (client, flags) {
        const existing = yield* resolveTask(client, flags.task);
        const schedule = yield* scheduleFromFlags(flags);
        const workspaceGiven = flags.root || Option.isSome(flags.worktree);
        if (Option.isSome(flags.thread) && (flags.newThread || workspaceGiven)) {
          return yield* fail(
            "--thread cannot be combined with --new-thread, --root, or --worktree.",
          );
        }

        // Where a task runs and its workspace change together: a task moved off
        // its thread must not start running loose in the project's checkout.
        let target: Pick<ScheduledTaskUpsertInput, "projectId" | "threadId" | "workspaceStrategy">;
        if (Option.isSome(flags.thread)) {
          const { thread } = yield* resolveThread(client, flags.thread.value);
          target = {
            projectId: thread.projectId,
            threadId: thread.id,
            workspaceStrategy: { type: "root" },
          };
        } else if (flags.newThread || (workspaceGiven && existing.threadId === null)) {
          target = {
            projectId: existing.projectId,
            threadId: null,
            workspaceStrategy: yield* newThreadWorkspace(flags),
          };
        } else if (workspaceGiven) {
          return yield* fail(
            "This task posts into a thread, which has its own workspace. Add --new-thread to change it.",
          );
        } else {
          target = {
            projectId: existing.projectId,
            threadId: existing.threadId,
            workspaceStrategy: existing.workspaceStrategy,
          };
        }

        const { task } = yield* client[WS_METHODS.scheduledTasksUpsert]({
          id: existing.id,
          requireExisting: true,
          title: Option.getOrElse(flags.title, () => existing.title),
          prompt: Option.isSome(flags.prompt)
            ? yield* readMessage([flags.prompt.value])
            : existing.prompt,
          enabled: existing.enabled,
          // A legacy sub-minute interval is kept as-is unless a new schedule is given.
          schedule: Option.getOrElse(schedule, () => existing.schedule),
          ...target,
          modelSelection: Option.isSome(flags.model)
            ? yield* parseModelSelection(flags.model.value, existing.modelSelection.instanceId)
            : existing.modelSelection,
          runtimeMode: Option.getOrElse(flags.runtimeMode, () => existing.runtimeMode),
          interactionMode: Option.getOrElse(flags.mode, () => existing.interactionMode),
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        });
        yield* printTask(client, task, flags.json, `Updated ${task.id}.`);
      }),
    ),
  ),
);

const setEnabledCommand = (name: "enable" | "disable", description: string) =>
  Command.make(name, { ...environmentTargetFlags, task: taskArgument, json: jsonFlag }).pipe(
    Command.withDescription(description),
    Command.withHandler(
      withClient(
        Effect.fn(`cli.schedule.${name}`)(function* (client, flags) {
          const existing = yield* resolveTask(client, flags.task);
          const { task } = yield* client[WS_METHODS.scheduledTasksSetEnabled]({
            id: existing.id,
            enabled: name === "enable",
          });
          if (flags.json) return yield* printJson(task);
          yield* Console.log(
            task.enabled
              ? `Enabled ${task.id}. Next run: ${task.nextRunAt ?? "-"}.`
              : `Paused ${task.id}.`,
          );
        }),
      ),
    ),
  );

const runCommand = Command.make("run", {
  ...environmentTargetFlags,
  task: taskArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run a scheduled task now, without changing its schedule."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.run")(function* (client, flags) {
        const existing = yield* resolveTask(client, flags.task);
        const { task } = yield* client[WS_METHODS.scheduledTasksRunNow]({ id: existing.id });
        if (flags.json) return yield* printJson(task);
        yield* Console.log(
          `Started ${task.id}${task.threadId === null ? "" : ` in thread ${task.threadId}`}. Check it with \`t3 schedule show ${task.id}\`.`,
        );
      }),
    ),
  ),
);

const deleteCommand = Command.make("delete", {
  ...environmentTargetFlags,
  task: taskArgument,
}).pipe(
  Command.withDescription("Delete a scheduled task. Use `disable` to keep it but stop its runs."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.schedule.delete")(function* (client, flags) {
        const existing = yield* resolveTask(client, flags.task);
        yield* client[WS_METHODS.scheduledTasksDelete]({ id: existing.id });
        yield* Console.log(`Deleted ${existing.id} (${existing.title}).`);
      }),
    ),
  ),
);

export const scheduleCommand = Command.make("schedule").pipe(
  Command.withDescription("Manage recurring tasks that run agents on a schedule."),
  Command.withSubcommands([
    listCommand,
    showCommand,
    addCommand,
    editCommand,
    setEnabledCommand("enable", "Resume a paused scheduled task."),
    setEnabledCommand("disable", "Pause a scheduled task without deleting it."),
    runCommand,
    deleteCommand,
  ]),
);
