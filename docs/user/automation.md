# Events, Hooks, Orchestrators, and Delegated Tasks

Let work continue without you watching it: react to what agents do, hand tasks to other threads
with a clear contract, and keep a long-lived agent that wakes up only when something needs it.
Everything here is driven from the `t3` CLI and runs in the T3 Code server, so it keeps working
with every app window and terminal closed. For work across machines, see
[peers, nodes, and jobs](./peers-and-jobs.md).

## Events

The server keeps a journal of what happened: threads created and organized, turns started and
finished, questions and approvals opened and resolved, tasks, jobs, and events your own tools
publish. Each entry has a cursor, so starting to watch late loses nothing.

```sh
t3 events watch --consumer my-script --type 'task.*' --format ndjson
t3 events read --cursor 120 --thread <thread> --json
echo '{"type":"custom.ci.build-finished","payload":{"status":"passed"}}' | t3 events emit --file -
```

- A named `--consumer` remembers where it stopped, across restarts. Closing the watch does not
  delete it.
- Your tools can publish only `custom.<namespace>.<name>` events. The server stamps who sent them;
  a tool cannot publish a turn result or an approval.
- The journal keeps a bounded history. A cursor older than that fails with `CURSOR_EXPIRED` and
  tells you the oldest one still available: read the current state, then continue from there.

## Hooks

A hook is a saved rule: when an event matches, deliver it somewhere. Hooks survive restarts and
retry on their own.

```sh
t3 hooks add --file docs/user/examples/automation/hook-task-completed.json
t3 hooks test <hook>            # shows what would be sent; sends nothing
t3 hooks deliveries --status failed --status suppressed
t3 hooks redeliver <delivery>
```

A hook delivers to an orchestrator's inbox or to a named CLI consumer. Webhooks and local commands
are available only when whoever runs the server has allowed them:

| Environment variable                  | Allows                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| `T3CODE_HOOK_WEBHOOK_ORIGINS`         | Webhook destinations, as a comma-separated list of origins |
| `T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS` | Origins that may resolve to a private network address      |
| `T3CODE_HOOK_COMMANDS`                | Commands, as absolute paths to the executables             |

"Delivered" means the event was stored at its destination, not that the work it triggers is done.
A hook that would loop, or fire too often for one task, is held back and listed as `suppressed`
rather than dropped.

## Orchestrators

An orchestrator is a persistent agent with its own thread, inbox, permissions, and budget. It
takes a turn only when its inbox has something to act on: a message from you, or an event a hook
routed to it. With nothing to do, it uses no model at all.

```sh
t3 orchestrator create --file docs/user/examples/automation/orchestrator-local.json
t3 orchestrator send <id> "Review yesterday's failed runs and delegate the fixes."
t3 orchestrator show <id>
t3 orchestrator pause <id>      # keeps the inbox; running child tasks continue
```

- Its thread is an ordinary thread: open it in the app or with `t3 thread show`. Settling,
  snoozing, or archiving that thread does not pause the orchestrator; `pause` and `disable` do.
- It handles one turn at a time. Messages that arrive meanwhile wait for the next turn.
- Limits on tokens, turns, and child tasks stop new turns when reached and keep the backlog. It
  never raises a limit or changes model on its own.
- It may answer a child's question when you allow `request.answer`. Approvals stay yours unless
  you pre-authorize a specific kind. When two orchestrators could answer the same request, only
  the one the server assigns can; `t3 orchestrator claims <id>` shows who owns what.
- After a crash, a turn whose outcome cannot be confirmed is left as `unknown` in the inbox
  instead of being run again. Decide with `t3 orchestrator inbox requeue|dismiss <entry>`.

### What its agent can do

During a turn, the orchestrator's agent drives T3 Code through the `t3` CLI in its shell. That
CLI belongs to the server running the orchestrator and is signed in as the orchestrator, not as
you, so the server checks every call against the orchestrator's `permissions`:

- `actions` names what it may do: `thread.read`, `thread.create`, `thread.send`,
  `thread.organize`, `thread.interrupt`, `request.answer`, `request.approve`, `task.delegate`,
  `task.cancel`, `peer.delegate`, `job.run`, `job.shell`, `event.emit`.
- `projectIds`, `environmentIds`, and `nodeIds` limit where. Leave one out to allow every
  project, peer, or node.
- `request.approve` does nothing alone. An approval also needs a `preAuthorizedApprovals` entry
  naming the request kind and the decision, and a decision you already made is never replaced.
- `job.shell` also needs `allowShell` on the node and a credential that carries
  `automation:execute`. Turn credentials do not carry it, so an orchestrator's agent cannot run
  shell jobs today.

A call outside these limits fails with `PERMISSION_DENIED` and changes nothing. The agent cannot
edit orchestrators, hooks, peers, or nodes, open terminals, change settings, or message its own
thread. Permissions are read when the call arrives, so an edit applies to the turn already
running. The credential ends with the turn, and at once when you pause, disable, or remove the
orchestrator.

Set `profile` to an [agent profile](agent-profiles.md) slug to run every turn with it. If the
profile is removed, disabled, or has no model for the thread's provider, the orchestrator stops
taking turns, keeps its inbox, and shows the reason in `t3 orchestrator show <id>`.

Orchestrators run on Codex and Claude provider instances. On any other provider the orchestrator
refuses to take turns and says so, because its agent could not be given its own identity there.
Use a full-access runtime mode: a sandbox that blocks local network access also blocks the CLI.

An orchestrator runs in one environment. Hosting it elsewhere means creating it there; moving a
running orchestrator between environments is not available yet.

## Delegated tasks

A delegated task is a contract plus a thread that carries it out: objective, deliverables, and
acceptance criteria go in, a report comes back.

```sh
t3 task delegate --file docs/user/examples/automation/task-remote-delegation.json --json
t3 task wait <task> --timeout 30m --json
t3 task validate <task> --file criteria.json
```

- Repeating a delegation with the same `idempotencyKey` returns the same task and thread.
- When the child finishes its turn the task is `reported`. It becomes `validated` only when you
  (or the orchestrator) check the criteria; `t3 task reject` sends it back with a reason.
- `unknown` means the outcome could not be established, for example after a crash. Run
  `t3 task reconcile <task>` before deciding anything.
- A task for another environment stays `pending_delivery` until that peer has stored it.
- Stopping a parent thread leaves its tasks running unless the task was created with
  `"onParentCancel": "cancel"`.

Child threads appear nested under their parent in the [sidebar](./thread-sidebar.md).

## In the app

Hooks and orchestrators can also be managed without the CLI. These settings appear only for
environments whose server supports automation; update the server on a machine that does not show
them.

### Orchestrators in the app

An orchestrator's thread carries a marker in the thread list and in the thread header. The header
spells out its state: idle, queued, running, waiting, paused, disabled, budget exceeded, handing
off, not hosted here, or error.

On web and desktop, open the thread's details to see the **Orchestrator** section: pause, resume,
or disable it, and interrupt the turn it is taking now, which is a separate action from pausing.
The section also shows its inbox, its usage against its budget, its child tasks, the questions and
approvals it is tracking, and recent activity. The command palette has **Open orchestrator panel**
and **Pause orchestrator** / **Resume orchestrator** for the thread you are in.

- Usage the provider does not report shows as **Unknown**, not zero.
- A child task shows **Reported** when it says it finished and **Validated** only once its
  criteria were checked.
- An inbox entry whose outcome is unknown stays listed until you **Requeue** or **Dismiss** it.
- An orchestrator hosted in another environment is a read-only copy. It shows when it was last
  observed and whether that environment is reachable; change it from the environment that hosts
  it.

Create and edit orchestrators in **Settings → Automation → Orchestrators**. Name, scope, project,
model, profile, runtime mode, instructions, and batch window are fields; permissions, budget, and
responsibility order are edited together as JSON, with the same keys as the CLI's definition file.
If someone else changed the orchestrator while you were editing, saving asks you to reload it.

On mobile, the thread list and header show the marker, and **Settings → Orchestrators, hooks,
peers and nodes** lists each environment's orchestrators. Open one to see the same details and to
pause or resume it. Creating, editing, disabling, interrupting a turn, and settling inbox entries
need desktop, web, or the CLI.

### Hooks in the app

**Settings → Automation → Hooks** lists each environment's hooks with a switch to enable them.
Create or edit a hook by choosing its event types, the projects, threads, or orchestrators it is
limited to, and where it delivers. Retry, timeout, priority, and limits are edited as JSON.

- **Test** shows which recent events match and what would be sent. It sends nothing.
- **Deliveries** lists what each hook delivered or is holding, filtered by status. **Redeliver** a
  failed or suppressed delivery, or dismiss it.
- A webhook or command destination is marked **Needs operator allowlist**: it works only when
  whoever runs that server allowed it, as described under [Hooks](#hooks).

Mobile lists hooks without editing them.

### Who answers a request

On web and desktop, when a question or approval is waiting and something other than you is
responsible for it, the thread, the thread list, and the Agent Operations Board name the
orchestrator or parent thread that is, and why. Seeing a request there does not make it yours to answer. An approval that only
you can decide says **Reserved for you**, even when an orchestrator is tracking it.

## Before closing the server

`t3 status` counts this work too: a running orchestrator turn, active child tasks, jobs, and hook
deliveries in flight block closing, and anything `unknown` makes readiness unknown. A paused
orchestrator holding a backlog and messages waiting for an offline peer do not block: both are
stored and resume after a restart.

## Updating from a version without automation

The first start after updating adds the automation tables to the existing database; nothing
existing is rewritten. To go back, install the previous version: it ignores those tables.
As with any update, copy your T3 home's `userdata` directory first if you want a restore point.
