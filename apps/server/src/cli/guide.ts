import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { buildCommandCatalog } from "./commandCatalog.ts";
import { failCli, jsonFlag, printJson, reportCliFailure } from "./common.ts";

/**
 * The operating manual a coding agent reads before driving T3 Code. Printed
 * by `t3 guide` so it ships with the CLI and matches the installed version;
 * docs/user/cli.md is the human reference and points here.
 */
export const AGENT_GUIDE = `# Driving T3 Code with the t3 CLI (guide for coding agents)

T3 Code runs coding agents (Codex, Claude, Cursor, OpenCode, ...) in threads on a
server ("environment"). The \`t3\` CLI controls that server: threads, terminals,
mini skills, agent profiles, and every server method.

Run \`t3 guide --json\` for this manual plus the complete command catalog,
including arguments, flags, aliases, and accepted choices. It needs no server.

## Rules
- Add --json to anything you parse. Errors go to stderr and exit non-zero.
- Ids: a thread accepts its full id or any unique prefix. Projects accept id,
  path, or title. Skills accept id or name. Profiles accept slug, id, or name.
- Long text: pass "-" (or pipe stdin) instead of a message, --content, or a
  JSON payload.
- Target: the server on this machine by default. Add --env <name> (or set
  T3CODE_ENV) for a saved remote environment. List them with \`t3 env list\`.
- Never wait with sleep loops. \`--wait\` and \`t3 thread wait\` are event-driven.

## Before closing or restarting T3 Code
  t3 status --json                     # work on this server, including archived threads
  t3 status --all --json               # local and all saved environments
  t3 status --check                    # non-zero if busy or readiness is unknown
  t3 status --watch 5s                 # detailed snapshots until you stop watching
Read safeToClose and each environment's blockers/unknowns. Waiting for input
is distinct from executing work; a paused thread may still have background
tasks. Low CPU or a sleeping process does not prove it is safe to close.
Check again immediately before closing: the report is a snapshot, not a lock.

## Core loop
  t3 project list --json
  t3 thread new "<task>" --project <p> --json            # returns {threadId}
  t3 thread wait <thread> --timeout 30m --json           # blocks until it stops
  t3 thread send <thread> "<follow-up>" --wait --json    # continue the conversation
Or in one step: t3 thread new "<task>" --project <p> --wait --json

wait/--wait prints: {thread: {status, ...}, reply, pendingApprovals,
pendingUserInputs, proposedPlan}. Branch on thread.status:
  completed            done; read "reply"
  waiting_for_approval approve or decline (see below), then wait again
  waiting_for_input    answer the question (see below), then wait again
  failed               read thread.lastError; send a new message to retry
  interrupted / idle   nothing running
  queued / starting / running  still working (wait returns only after these)
A thread with hasActionableProposedPlan has a plan (from --mode plan) in
"proposedPlan"; send "Implement the plan" with --mode default to carry it out.

## Starting a thread
  t3 thread new "<message>" [--project <p>] [--model <instance>/<model>]
     [--runtime-mode approval-required|auto-accept-edits|auto|full-access]
     [--mode default|plan] [--worktree <base-branch>] [--title <t>]
     [--skill <skill>]... [--profile <profile>] [--wait [--timeout 30m]]
Defaults come from the project's settings (model, permission mode). The
project defaults to the one containing the current directory (local only).
--worktree creates an isolated git worktree branched from <base-branch> and
runs the project's setup script there.

## Reading
  t3 thread list [--project <p>] [--status <s>] [--archived] [--limit 50] --json
  t3 thread show <thread> [--turns 5] --json   # messages (with appliedSkills /
                                               # appliedProfile), pending requests, plan

## Approvals and questions
  t3 thread approve <thread> [--request <id>]
     [--decision accept|acceptForSession|acceptAlways|decline|cancel]
  t3 thread answer <thread> <question-id>=<answer>...   # repeat an id for multi-select
  t3 thread answer <thread> "<answer>"                  # single-question requests
  t3 thread answer <thread> --dismiss                   # close an async question
Request and question ids come from \`show --json\` or the wait output.

## Controlling and organizing
  t3 thread interrupt <thread>         stop the current turn
  t3 thread stop <thread>              stop the provider session
  t3 thread rename <thread> "<title>"
  t3 thread pin|unpin|settle|unsettle|archive|unarchive|unsnooze|delete <thread>
  t3 thread snooze <thread> <duration|ISO datetime>   (30m, 2h, 1d, 2026-01-31T09:00:00Z)
  t3 thread send <thread> "<text>" [--queue | --steer]
  t3 thread tree <thread> --json       the thread with its child threads and tasks
  t3 thread requests [--thread <t>] --json   pending questions and approvals, with owner
Snooze hides a thread until a time kept by the server; it never stops the
agent. archive is refused while a turn is active: interrupt first.
Mutations take --idempotency-key <key>: repeating one returns the first result.
With --json a failure prints {"error":{"code","message","detail"}} on stderr.
Codes are stable: NOT_FOUND, INVALID_INPUT, CONFLICT, PERMISSION_DENIED,
REQUEST_ALREADY_RESOLVED, REQUEST_EXPIRED, NOT_OWNER, ENVIRONMENT_UNAVAILABLE,
CAPABILITY_UNSUPPORTED, RESULT_UNKNOWN. A wait that times out cancels nothing.
answer never approves and approve never answers; with several requests pending
you must name one with --request <id>.

## Delegated tasks (work handed to a managed thread, with a contract)
  t3 task delegate --file task.json|- --json     same idempotencyKey = same task and thread
  t3 task show|list|tree <task> --json
  t3 task wait <task> [--timeout 30m] --json     event-driven; a timeout cancels nothing
  t3 task send <task> "<text>"                   message the child
  t3 task validate <task> --file criteria.json|- | t3 task reject <task> "<reason>"
  t3 task cancel|reconcile <task>
A finished turn makes a task "reported", not "validated": check the acceptance
criteria, then validate or reject. "unknown" means the outcome could not be
established: reconcile it, never assume. A target on another environment stays
"pending_delivery" until that peer stores it.
Example: docs/user/examples/automation/task-remote-delegation.json

## Events (cursor-addressed journal; nothing is lost if you start late)
  t3 events status --json                      headCursor, oldestCursor
  t3 events read [--cursor N] [--type task.* --thread <id>] --json   -> nextCursor
  t3 events watch [--cursor N | --consumer <name>] [--type ...] [--format ndjson] [--once]
      --consumer resumes after the last line printed; --once exits when caught up
  t3 events emit --file event.json|- [--key <k>]   type must be custom.<ns>.<name>
  t3 events consumers list | delete <name>
A cursor older than retention fails with CURSOR_EXPIRED and the oldest cursor;
read current state, then resume from there. Events are not replayed for you.

## Hooks (declarative delivery of matching events)
  t3 hooks add --file hook.json|-              see docs/user/examples/automation/
  t3 hooks edit <hook> --file changes.json|-   only the fields to change
  t3 hooks list | show <hook> | enable|disable|remove <hook>
  t3 hooks test <hook> [--deliver]             dry run unless --deliver
  t3 hooks deliveries [hook] [--status failed --status suppressed]
  t3 hooks redeliver|dismiss <delivery>
Targets: orchestrator_inbox and cli_consumer always; webhook and command only
where the server operator allowed them. "delivered" means stored at the target,
not that the work it triggers is done.

## Orchestrators (a persistent agent with an inbox, woken by events)
  t3 orchestrator create --file orchestrator.json|- --json
  t3 orchestrator edit <id> --file changes.json|-
  t3 orchestrator list | show <id> --json      state, reason, usage, budget, host
  t3 orchestrator send <id> "<text>"|- [--idempotency-key <k>]
  t3 orchestrator pause|resume|disable <id> [--interrupt] | interrupt <id>
  t3 orchestrator inbox <id> [--status s] | inbox requeue|dismiss <entry>
  t3 orchestrator checkpoints <id> | claims <id>
  t3 orchestrator claim transfer (--thread <t> --request <r> | --task <id>)
     --to user|thread:<id>|orchestrator:<id> [--expected-generation n]
  t3 orchestrator remove <id>                  the thread stays
Pausing keeps the inbox and never cancels children. Its main thread is an
ordinary thread: settle, snooze or archive do not pause the orchestrator.
Examples: docs/user/examples/automation/orchestrator-local.json, orchestrator-global.json

## Peers (another environment, reached directly; no relay)
  t3 peer identity                              this environment's id
  t3 peer credential create <caller-env-id> [--session] [--base-url <url>]
      run on the side being called; each side adds the other
  t3 peer add <name> <pairing-link> | <url> --token <t> [--permissions-file f|-]
  t3 peer list|show|update|enable|disable|remove ; t3 peer outbox [peer] [--all]
A new peer may ask nothing until you grant it. "delivered" means the peer
stored the message. An offline peer leaves messages pending; they are sent
once when it returns.

## Nodes and jobs (run a command in an allowed workspace, traceably)
  t3 node list|add <label> --ssh <target> --root <dir>|edit|remove|probe
  t3 node exec <node> --file job.json|- [--wait] [--timeout 10m]   prints the job id
  t3 job show|list|wait|logs [--follow]|cancel|reconcile <job>
  job.json: {"cwd": "/abs", "action": {"type":"command","executable":"npm","args":["test"]}}
A node runs nothing until it has a workspace root (t3 node edit local --root <dir>).
wait --timeout stops waiting, not the job. An "unknown" job is never re-run
for you: reconcile it.

## Mini skills (reusable Markdown instructions)
  t3 skill list --json | t3 skill show <skill> --json
  t3 skill create "<name>" --content "<markdown>" | --file <path> | --content -
     [--description <d>] [--default true|false]   # default = attach to new threads
  t3 skill edit <skill> [--name] [--description] [--content|--file|--editor]
     [--default true|false]
  t3 skill delete <skill>
Use one for a single message: t3 thread send <thread> "..." --skill <skill>.
Threads keep the copy of default skills they were created with.

## Agent profiles (named presets: model routes, effort, skills, instructions)
  t3 profile list --json | t3 profile show <profile> --json
  t3 profile create "<name>" [--slug <slug>] [--description <d>]
     [--reasoning-effort low|medium|high] [--skills "<skill>,<skill>"]
     [--instructions "<markdown>" | --instructions-file <path> | --editor]
     [--route <instance>=<model>[,<fallback>...][@<effort>]]...
     [--template-file <path>]   # must contain {{user_message}}
     [--enabled true|false]
  t3 profile edit <profile> [same flags] [--name <n>]   # only given fields change;
                                                         # --route replaces all routes
  t3 profile delete <profile>
Use one for a message: --profile <slug>. It adapts to the thread's provider
(it never switches provider) and fails clearly if no candidate model exists.

## Terminals (per thread; open in its worktree or project folder)
  t3 terminal run <thread> "<command>" [--idle 2s] [--timeout 5m]
      prints output until the terminal is quiet for --idle
  t3 terminal write <thread> "<text>" [--no-enter]   long-running commands
  t3 terminal read <thread> [--lines 200]            scrollback
  t3 terminal list [--thread <thread>] --json
  t3 terminal open|clear|restart|close <thread>  (--terminal <id>, default term-1)
  t3 terminal attach <thread>                        interactive (humans; Ctrl-] detaches)
Output is plain text; --raw keeps ANSI escapes.

## Scheduled tasks (recurring agent runs; they run with no app open)
  t3 schedule add "<prompt>" --every 2h | --at 09:00 [--days mon-fri]
     [--thread <thread> | --project <p> [--worktree <base> | --root]]
     [--title <t>] [--model <instance>/<model>] [--runtime-mode <m>]
     [--mode default|plan] [--paused] --json
  Default: each run starts a new thread in the project, in a fresh worktree
  from main. --thread posts every run into that thread instead.
  --every is at least 1m. --at is HH:MM in the environment's time zone.
  --days: mon-fri, sat,sun, weekdays, weekends, 1,3,5 (0 = Sunday).
  t3 schedule list [--project <p>] --json     nextRunAt, lastRunStatus, lastRunError
  t3 schedule show <task> --json
  t3 schedule edit <task> [same flags] [--prompt <text>] [--new-thread]
  t3 schedule enable|disable|run|delete <task>
A task accepts its id, the start of its id, or its exact title.

## Anything else: call server methods directly
  t3 rpc list [filter]              e.g. t3 rpc list git
  t3 rpc describe <method>          payload/result as JSON Schema
  t3 rpc call <method> '<json>'     unary methods print one JSON value;
                                    streams print one JSON event per line
                                    (--limit N, --timeout 30s)
Covers git and pull requests, settings, providers, files, diffs, search, and
everything else the apps can do.

## Projects
  t3 project list --json
  t3 project add <path> [--title <t>]      with --env: a path on that machine
  t3 project rename <project> "<title>" | t3 project remove <project> [--force]

## Environments
  t3 env add <name> "<pairing-link>"          pair like a device
  t3 env add <name> <url> --token <token>     token from \`t3 auth session issue\`
  t3 env list | t3 env remove <name>
Works for any reachable server: LAN, Tailscale, or a T3 Connect tunnel URL.
--env works on project, thread, terminal, schedule, skill, profile, auth, rpc,
doctor.
service, update, uninstall, connect, pair, theme act on the machine they run on.
  t3 auth pairing create|list|revoke --env <name>     needs an administrative token
  t3 auth session list|revoke --env <name>            (saved with env add --token)

## When an environment does not answer
  t3 doctor --env <name> --json     one environment
  t3 doctor --all --json            this machine, every environment, and what
                                    works between each pair of them
Prints {ok, sections: [{title, checks: [{id, status, summary, hint}]}]} and
exits non-zero on a problem. status is ok, info, warn, or fail; "hint" is the
fix. Checks run outside-in and stop at the first broken layer: Tailscale path
(tailnet), server reachable (http), same server as paired (identity),
credential, WebSocket (rpc), then the host's own report (host-tailscale*,
tailscale-serve). Run it before retrying a command that failed to connect.
`;

/** Topic id, the guide heading it prints, and the command groups it covers. */
const GUIDE_TOPICS = [
  { id: "rules", heading: "## Rules", groups: [] },
  { id: "status", heading: "## Before closing or restarting T3 Code", groups: ["status"] },
  { id: "threads", heading: "## Core loop", groups: ["thread"], through: "## Mini skills" },
  { id: "tasks", heading: "## Delegated tasks", groups: ["task"] },
  { id: "events", heading: "## Events", groups: ["events"] },
  { id: "hooks", heading: "## Hooks", groups: ["hooks"] },
  { id: "orchestrators", heading: "## Orchestrators", groups: ["orchestrator"] },
  { id: "peers", heading: "## Peers", groups: ["peer"] },
  { id: "jobs", heading: "## Nodes and jobs", groups: ["node", "job"] },
  { id: "skills", heading: "## Mini skills", groups: ["skill"] },
  { id: "profiles", heading: "## Agent profiles", groups: ["profile"] },
  { id: "terminals", heading: "## Terminals", groups: ["terminal"] },
  { id: "schedules", heading: "## Scheduled tasks", groups: ["schedule"] },
  { id: "rpc", heading: "## Anything else", groups: ["rpc"] },
  { id: "projects", heading: "## Projects", groups: ["project"] },
  { id: "environments", heading: "## Environments", groups: ["env", "auth"], through: null },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly heading: string;
  readonly groups: ReadonlyArray<string>;
  /** Where the topic's text ends: a later heading, or null for the end. Default: the next heading. */
  readonly through?: string | null;
}>;

export const GUIDE_TOPIC_IDS: ReadonlyArray<string> = GUIDE_TOPICS.map((topic) => topic.id);

/** The guide text of one topic, or undefined when the id is unknown. */
export const guideTopicText = (id: string): string | undefined => {
  const topic = GUIDE_TOPICS.find((candidate) => candidate.id === id);
  if (topic === undefined) return undefined;
  const start = AGENT_GUIDE.indexOf(topic.heading);
  if (start < 0) return undefined;
  const through = "through" in topic ? topic.through : undefined;
  const end =
    through === null ? -1 : AGENT_GUIDE.indexOf(through ?? "\n## ", start + topic.heading.length);
  return (end < 0 ? AGENT_GUIDE.slice(start) : AGENT_GUIDE.slice(start, end)).trimEnd();
};

type CatalogEntry = ReturnType<typeof buildCommandCatalog>[number];

const topicCommands = (catalog: ReadonlyArray<CatalogEntry>, id: string) => {
  const groups: ReadonlyArray<string> = GUIDE_TOPICS.find((topic) => topic.id === id)?.groups ?? [];
  return catalog.filter((entry) => entry.path[1] !== undefined && groups.includes(entry.path[1]));
};

/** One line per runnable command: its usage and what it does. */
const compactListing = (catalog: ReadonlyArray<CatalogEntry>) =>
  catalog
    .filter((entry) => !entry.unlisted && entry.subcommands.length === 0)
    .map((entry) => `${entry.usage}${entry.description ? `  # ${entry.description}` : ""}`)
    .join("\n");

export const makeGuideCommand = (getRoot: () => Command.Command.Any) =>
  Command.make("guide", {
    json: jsonFlag,
    topic: Flag.String("topic").pipe(
      Flag.withDescription("Print one topic only. List them with --topics."),
      Flag.optional,
    ),
    topics: Flag.Boolean("topics").pipe(
      Flag.withDescription("List the guide's topics."),
      Flag.withDefault(false),
    ),
    compact: Flag.Boolean("compact").pipe(
      Flag.withDescription("One line per command instead of the prose guide."),
      Flag.withDefault(false),
    ),
  }).pipe(
    Command.withDescription("Print the guide for driving T3 Code from scripts and coding agents."),
    Command.withHandler(({ json, topic, topics, compact }) =>
      Effect.suspend(() => {
        if (topics) {
          return json
            ? printJson({ topics: GUIDE_TOPIC_IDS })
            : Console.log(GUIDE_TOPIC_IDS.join("\n"));
        }
        const catalog = buildCommandCatalog(getRoot());
        const topicId = Option.getOrUndefined(topic);
        if (topicId === undefined) {
          if (json) {
            return printJson({
              schemaVersion: 1,
              version: packageJson.version,
              guide: AGENT_GUIDE,
              commands: catalog,
            });
          }
          return Console.log(compact ? compactListing(catalog) : AGENT_GUIDE);
        }
        const text = guideTopicText(topicId);
        if (text === undefined) {
          return failCli(
            "NOT_FOUND",
            `Unknown guide topic "${topicId}". Topics: ${GUIDE_TOPIC_IDS.join(", ")}.`,
          );
        }
        const commands = topicCommands(catalog, topicId);
        if (json) {
          return printJson({
            schemaVersion: 1,
            version: packageJson.version,
            topic: topicId,
            guide: text,
            commands,
          });
        }
        return Console.log(compact ? compactListing(commands) : text);
      }).pipe(reportCliFailure(json)),
    ),
  );
