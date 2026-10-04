# Controlling T3 Code from the command line

The `t3` CLI drives a running T3 Code server from a terminal. Anything you do in
the app can be done from it: start and continue conversations, wait for agents,
answer their approvals and questions, use thread terminals, manage mini skills
and agent profiles, and call any other server feature. It is built for scripts
and for other coding agents.

**Using it from a coding agent?** Run `t3 guide`. It prints a compact operating
manual for agents that always matches the installed version.

## Basics

- **Target.** Commands talk to the server on this machine (the desktop app or
  `t3` must be running). Add `--env <name>` to target a saved remote
  environment instead, or set `T3CODE_ENV` for a whole shell or agent session.
  See [Environments](#environments).
- **Output.** Every command that prints data accepts `--json`. Errors go to
  stderr and the command exits with a non-zero status.
- **Identifiers.** A thread accepts its id or any unique prefix of it. A
  project accepts its id, path, or title. A mini skill accepts its id or name.
  An agent profile accepts its slug, id, or name.
- **Long text.** Pass `-` instead of a message, `--content`, `--instructions`,
  or an `rpc` payload to read it from stdin.
- **Help.** `t3 <command> --help` lists every flag.

## Projects

| Task             | Command                                 |
| ---------------- | --------------------------------------- |
| List projects    | `t3 project list`                       |
| Add a project    | `t3 project add <path> [--title <t>]`   |
| Rename a project | `t3 project rename <project> <title>`   |
| Remove a project | `t3 project remove <project> [--force]` |

With `--env`, `<path>` is a folder on that environment's machine.

## Threads

### Start and continue conversations

| Task                                       | Command                                     |
| ------------------------------------------ | ------------------------------------------- |
| Start a thread                             | `t3 thread new "<message>" [--project <p>]` |
| Send a message to an existing thread       | `t3 thread send <thread> "<message>"`       |
| Wait until the agent finishes or needs you | `t3 thread wait <thread> [--timeout 30m]`   |
| Stop the current turn                      | `t3 thread interrupt <thread>`              |
| Stop the provider session                  | `t3 thread stop <thread>`                   |

`new` and `send` return as soon as the server accepts the message; `new`
prints the new thread's id. Add `--wait` to block until the agent stops, then
print its reply and anything it is waiting on. A message sent while the agent
is busy runs as the next turn.

Options for `new` and `send`:

| Flag                                  | Effect                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `--model <instance>/<model>`          | Model to use. `<model>` alone keeps the current provider.                |
| `--runtime-mode <mode>`               | `approval-required`, `auto-accept-edits`, `auto`, or `full-access`.      |
| `--mode plan`                         | Ask for a plan instead of changes. `--mode default` goes back.           |
| `--skill <skill>`                     | Apply a mini skill to this message. Repeat for more.                     |
| `--profile <profile>`                 | Apply an agent profile to this message.                                  |
| `--wait`, `--timeout <duration>`      | Block until the agent stops; give up after the duration.                 |
| `--project <p>` (new only)            | Project to start in. Default: the project containing the current folder. |
| `--worktree <base-branch>` (new only) | Run in a new git worktree from that branch and run the setup script.     |
| `--title <title>` (new only)          | Thread title. Default: derived from the message.                         |

`new` uses the project's default model and permission mode unless you override
them. `send` keeps the thread's current model and modes.

### Read threads

| Task                                | Command                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| List threads and their status       | `t3 thread list [--project <p>] [--status <s>] [--archived] [--limit 50]` |
| Read a thread's recent conversation | `t3 thread show <thread> [--turns 5]`                                     |

`show` also lists the mini skills and profile applied to each message, pending
approvals and questions with their ids, and the latest proposed plan.

### Statuses

`list`, `show`, and `wait` report one status per thread:

| Status                 | Meaning                                      |
| ---------------------- | -------------------------------------------- |
| `queued`               | A message was sent and is waiting to start.  |
| `starting`, `running`  | The agent is working.                        |
| `waiting_for_approval` | The agent needs permission to continue.      |
| `waiting_for_input`    | The agent asked a question.                  |
| `completed`            | The agent finished its turn.                 |
| `failed`               | The turn or session failed; see `lastError`. |
| `interrupted`          | The turn was stopped before finishing.       |
| `idle`                 | Nothing has run in this session yet.         |

`wait` returns on anything other than `queued`, `starting`, and `running`.

### Approvals and questions

When a thread is `waiting_for_approval`, `t3 thread approve <thread>` accepts
the oldest pending request. Choose another with `--request <id>` and another
answer with `--decision` (`accept`, `acceptForSession`, `acceptAlways`,
`decline`, or `cancel`).

When it is `waiting_for_input`, answer with
`t3 thread answer <thread> <question-id>=<answer>`. Repeat a question id to
pick several options of a multi-select question. A request with a single
question accepts a bare answer. `--dismiss` closes a question that does not
block the agent. Use `--request <id>` when several are pending.

### Organize threads

| Task                | Command                                                       |
| ------------------- | ------------------------------------------------------------- |
| Rename              | `t3 thread rename <thread> "<title>"`                         |
| Pin or unpin        | `t3 thread pin <thread>`, `t3 thread unpin <thread>`          |
| Snooze or wake      | `t3 thread snooze <thread> 2h`, `t3 thread unsnooze <thread>` |
| Mark done or reopen | `t3 thread settle <thread>`, `t3 thread unsettle <thread>`    |
| Archive or restore  | `t3 thread archive <thread>`, `t3 thread unarchive <thread>`  |
| Delete permanently  | `t3 thread delete <thread>`                                   |

## Mini skills

[Mini skills](./mini-skills.md) are reusable Markdown instructions.

| Task                       | Command                                                      |
| -------------------------- | ------------------------------------------------------------ |
| List                       | `t3 skill list`                                              |
| Read one, with its content | `t3 skill show <skill>`                                      |
| Create                     | `t3 skill create "<name>" --content "<markdown>"`            |
| Edit                       | `t3 skill edit <skill> [--name] [--description] [--content]` |
| Delete                     | `t3 skill delete <skill>`                                    |

The instructions come from `--content` (`-` for stdin), `--file <path>`, or
`--editor`, which opens `$VISUAL` or `$EDITOR` (on `edit`, with the current
text). `--description` sets the one-line summary. `--default true` attaches the
skill to every new thread; `--default false` stops that.

`edit` only changes the fields you pass. Threads keep the copy of their default
skills they were created with, so editing or deleting a skill never changes an
existing thread.

To apply skills to one message, pass `--skill <skill>` to `thread new` or
`thread send`.

## Agent profiles

[Agent profiles](./agent-profiles.md) are named presets for a kind of work.

| Task             | Command                                |
| ---------------- | -------------------------------------- |
| List             | `t3 profile list`                      |
| Read one in full | `t3 profile show <profile>`            |
| Create           | `t3 profile create "<name>" [options]` |
| Edit             | `t3 profile edit <profile> [options]`  |
| Delete           | `t3 profile delete <profile>`          |

Options for `create` and `edit` (`edit` only changes the ones you pass):

| Flag                                                              | Effect                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--slug <slug>`                                                   | Handle for `#slug` in the composer and `--profile` here. Default: from the name.                     |
| `--name <name>` (edit only)                                       | Rename the profile.                                                                                  |
| `--description <text>`                                            | One-line summary.                                                                                    |
| `--enabled true\|false`                                           | Whether the profile can be selected.                                                                 |
| `--reasoning-effort <effort>`                                     | Base reasoning effort. `''` inherits the current one.                                                |
| `--skills "<skill>,<skill>"`                                      | Mini skills applied with the profile.                                                                |
| `--instructions <text>`, `--instructions-file <path>`, `--editor` | The profile's instructions (`-` reads stdin).                                                        |
| `--route <instance>=<model>[,<fallback>...][@<effort>]`           | Model per provider instance, with fallbacks and an effort. Repeat per instance; replaces all routes. |
| `--template-file <path>`                                          | Custom prompt template; must contain `{{user_message}}`. `''` restores the default.                  |

To use a profile for one message, pass `--profile <slug>` to `thread new` or
`thread send`. The profile adapts to the thread's provider and never switches
it; if none of its models for that provider is available, the command fails
and says why.

## Terminals

Each thread has its own terminals, opened in the thread's worktree or project
folder. `--terminal <id>` picks one (default `term-1`).

| Task                               | Command                                            |
| ---------------------------------- | -------------------------------------------------- |
| List terminals and what they run   | `t3 terminal list [--thread <thread>]`             |
| Run a command and print its output | `t3 terminal run <thread> "<command>"`             |
| Type into a terminal               | `t3 terminal write <thread> "<text>" [--no-enter]` |
| Print recent scrollback            | `t3 terminal read <thread> [--lines 200]`          |
| Use a terminal interactively       | `t3 terminal attach <thread>`                      |
| Open, clear, restart, or close     | `t3 terminal open\|clear\|restart\|close <thread>` |

`run` prints output until the terminal is quiet for `--idle` (default 2s), so
start long-running commands with `write` and check on them with `read`.
`attach` connects your terminal to it; press Ctrl-] to detach. Output is plain
text unless you pass `--raw`. `close --delete-history` also removes the saved
scrollback.

## Scheduled tasks

A scheduled task runs an agent with the same prompt on a recurring schedule,
even when no app is open. These are the tasks listed under **Settings →
Scheduled tasks**.

| Task                      | Command                                                   |
| ------------------------- | --------------------------------------------------------- |
| List tasks                | `t3 schedule list [--project <p>]`                        |
| Read one, with its prompt | `t3 schedule show <task>`                                 |
| Run on an interval        | `t3 schedule add "<prompt>" --every 2h`                   |
| Run at a time of day      | `t3 schedule add "<prompt>" --at 09:00 [--days mon-fri]`  |
| Change a task             | `t3 schedule edit <task> [options]`                       |
| Pause or resume           | `t3 schedule disable <task>`, `t3 schedule enable <task>` |
| Run now                   | `t3 schedule run <task>`                                  |
| Delete                    | `t3 schedule delete <task>`                               |

A task accepts its id, the start of its id, or its exact title.

`--every` takes an interval of at least one minute, such as `30m`, `2h`, or
`1d`. `--at` takes a 24-hour time in the environment's time zone, which may
differ from yours when you use `--env`. `--days` accepts names or numbers
(`0` is Sunday), lists, and ranges: `mon-fri`, `sat,sun`, `weekdays`,
`weekends`, `1,3,5`. Without it the task runs every day.

A task runs in one of two places:

- **A new thread each run** (the default), in `--project <p>` or the project
  containing the current folder. Each run gets a fresh worktree branched from
  `main`, so unattended runs do not edit your checkout. `--worktree <branch>`
  picks another base branch, and `--root` runs in the project folder instead.
  The model and permission mode default to the project's, as for
  `t3 thread new`.
- **One thread**, with `--thread <thread>`. Every run posts into it and
  continues its conversation, using that thread's model, modes, and workspace.

`--model`, `--runtime-mode`, `--mode`, and `--title` override the defaults, and
`--paused` creates the task without starting its schedule. The prompt can come
from stdin with `-`.

`edit` changes only what you pass. `--thread <thread>` moves a task into a
thread and `--new-thread` moves it back to a new thread per run. `run` starts
the task immediately and leaves its schedule unchanged; `show` reports the
last run's result and error.

## Fork maintenance

`t3 fork sync` merges upstream into your fork's target branch and pushes the
result. It works in an isolated worktree; merge conflicts and verification
failures can be handled by an agent through the T3 Code server on this machine.
Add your fork checkout as a project before using agent-assisted resolution.

Create `~/.local/share/t3code-sync/config.env` with at least:

```sh
REPO="/path/to/your/t3code-checkout"
```

The defaults use `upstream/main`, `origin`, and the fork's `main` branch.
Set `BUILD_APP=1` to build the desktop app after syncing, and `RESTART_APP=1`
to install the result. Installation closes the running app; save ongoing work
first. `t3 fork build` builds the target branch without syncing.

Use `t3 fork status` to inspect the last run, logs, and pending alerts. Pass
`--no-push` or `--no-build` to `sync` to skip those steps, or `--config-dir`
to use a different configuration directory.

## Everything else

`t3 rpc` calls any server method directly, the same ones the apps use for git
and pull requests, settings, providers, files, diffs, search, and more.

| Task                               | Command                                 |
| ---------------------------------- | --------------------------------------- |
| List methods (optionally filtered) | `t3 rpc list [git]`                     |
| Show a method's payload and result | `t3 rpc describe <method>`              |
| Call a method                      | `t3 rpc call <method> '<json-payload>'` |

Methods that stream print one JSON event per line until they end; `--limit`
and `--timeout` stop them sooner. An invalid payload is rejected before it
reaches the server, with the field that is wrong.

## Environments

Save any environment you can reach once (on your network, over Tailscale, or
through a T3 Connect tunnel URL), then pass `--env <name>` to any `project`,
`thread`, `terminal`, `schedule`, `skill`, `profile`, `auth`, `rpc`, or
`doctor` command.
Set `T3CODE_ENV` to make one the default for a shell or an agent session.

| Task                               | Command                                   |
| ---------------------------------- | ----------------------------------------- |
| Pair with a pairing link           | `t3 env add <name> "<pairing-link>"`      |
| Use a token from the other machine | `t3 env add <name> <url> --token <token>` |
| List saved environments            | `t3 env list`                             |
| Forget one                         | `t3 env remove <name>`                    |

Create the pairing link in the target environment's Connections settings, or
with `t3 pair` on that machine; `t3 auth session issue` there prints a token.
A pairing link works once. Removing an environment only forgets it on this
machine; revoke its access from the target's Connections settings.

`service`, `update`, `uninstall`, `connect`, `pair`, and `theme` manage the
installation on the machine they run on, so they take no `--env`. From another
machine, `t3 rpc call server.updateServer --env <name>` updates a server and
`t3 auth pairing create --env <name>` creates a pairing link for it.

### Manage access remotely

`t3 auth pairing create|list|revoke` and `t3 auth session list|revoke` accept
`--env` and then act on that environment. They need an administrative
credential: a pairing link grants a standard one, so save the environment with
a token instead. On the target machine run `t3 auth session issue`, then here
`t3 env add <name> <url> --token <token>`.

## Diagnose connections

`t3 doctor` explains why an environment is or is not reachable, and what to do
about it. It exits with a non-zero status when it finds a problem.

| Task                                               | Command                  |
| -------------------------------------------------- | ------------------------ |
| Check this machine and its server                  | `t3 doctor`              |
| Check one saved environment                        | `t3 doctor --env <name>` |
| Check every environment and the paths between them | `t3 doctor --all`        |
| Keep checking and print what changes               | `t3 doctor --watch 30s`  |

For each environment it checks, in order: the Tailscale path from this machine
(is the node in your tailnet, online, and reached directly or through a relay),
whether a T3 Code server answers at the saved address and is the one you
paired with, whether the saved credential is still accepted, and whether the
WebSocket connection works. It stops at the first layer that fails.

When the environment is reachable, its host also reports its own side:
whether Tailscale is running and signed in there, whether its key is about to
expire, and whether Tailscale Serve forwards to the port T3 Code listens on.
That host report needs a server recent enough to provide it.

`--all` adds a section about each pair of environments. Syncing a project or
handing off a thread between two environments is driven by the device you run
it from, so it works when that device reaches both and both servers support
it; the section says so, or names the server to update. It also shows whether
each host sees the other online in the tailnet, which only matters for
features that connect hosts directly, such as an AI runtime shared over the
tailnet.

A line starting with `✗` is a problem, `!` a warning, and `→` the suggested
fix. `--json` prints the same checks as `{ok, sections}`.
