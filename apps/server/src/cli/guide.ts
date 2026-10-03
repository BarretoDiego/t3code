import * as Console from "effect/Console";
import { Command } from "effect/unstable/cli";

/**
 * The operating manual a coding agent reads before driving T3 Code. Printed
 * by `t3 guide` so it ships with the CLI and matches the installed version;
 * docs/user/cli.md is the human reference and points here.
 */
export const AGENT_GUIDE = `# Driving T3 Code with the t3 CLI (guide for coding agents)

T3 Code runs coding agents (Codex, Claude, Cursor, OpenCode, ...) in threads on a
server ("environment"). The \`t3\` CLI controls that server: threads, terminals,
mini skills, agent profiles, and every server method.

## Rules
- Add --json to anything you parse. Errors go to stderr and exit non-zero.
- Ids: a thread accepts its full id or any unique prefix. Projects accept id,
  path, or title. Skills accept id or name. Profiles accept slug, id, or name.
- Long text: pass "-" (or pipe stdin) instead of a message, --content, or a
  JSON payload.
- Target: the server on this machine by default. Add --env <name> (or set
  T3CODE_ENV) for a saved remote environment. List them with \`t3 env list\`.
- Never wait with sleep loops. \`--wait\` and \`t3 thread wait\` are event-driven.

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
  t3 thread snooze <thread> <duration>     (30m, 2h, 1d)

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
--env works on project, thread, terminal, skill, profile, auth, rpc, doctor.
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

export const guideCommand = Command.make("guide").pipe(
  Command.withDescription("Print the guide for driving T3 Code from scripts and coding agents."),
  Command.withHandler(() => Console.log(AGENT_GUIDE)),
);
