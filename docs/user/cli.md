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
through a T3 Connect tunnel URL), then pass `--env <name>` to any `thread`,
`terminal`, `skill`, `profile`, or `rpc` command. Set `T3CODE_ENV` to make one
the default for a shell or an agent session.

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
