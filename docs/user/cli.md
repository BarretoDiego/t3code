# Controlling T3 Code from the command line

The `t3` CLI drives a running T3 Code server from a terminal: start threads,
send messages, wait for agents, answer their approvals and questions, and use
thread terminals. It is built for scripts and for other coding agents, so every
command that prints data accepts `--json`.

By default commands target the server on this machine (the desktop app or `t3`
must be running). Add `--env <name>` to target another environment instead.

## Environments

Save any environment you can reach — on your network, over Tailscale, or
through a T3 Connect tunnel URL — once, then pass `--env <name>` to any
`thread`, `terminal`, or `rpc` command. Set `T3CODE_ENV` to make one the
default for a shell or an agent session.

| Task                               | Command                                   |
| ---------------------------------- | ----------------------------------------- |
| Pair with a pairing link           | `t3 env add <name> "<pairing-link>"`      |
| Use a token from the other machine | `t3 env add <name> <url> --token <token>` |
| List saved environments            | `t3 env list`                             |
| Forget one                         | `t3 env remove <name>`                    |

Create the pairing link in the target environment's Connections settings, or
with `t3 pair` on that machine; `t3 auth session issue` there prints a token.
Removing an environment only forgets it locally; revoke its access from the
target's Connections settings.

## Start and continue conversations

| Task                                       | Command                                         |
| ------------------------------------------ | ----------------------------------------------- |
| List projects                              | `t3 project list`                               |
| List threads and their status              | `t3 thread list [--project <p>] [--status <s>]` |
| Read a thread's recent conversation        | `t3 thread show <thread> [--turns 5]`           |
| Start a thread                             | `t3 thread new "<message>" [--project <p>]`     |
| Send a message to an existing thread       | `t3 thread send <thread> "<message>"`           |
| Wait until the agent finishes or needs you | `t3 thread wait <thread> [--timeout 30m]`       |
| Stop the current turn                      | `t3 thread interrupt <thread>`                  |

`<thread>` is a thread id or any unique prefix of one. `--project` takes a
project id, path, or title, and defaults to the project that contains the
current directory. Pass `-` (or pipe text in) instead of a message to read it
from stdin.

`new` and `send` return as soon as the server accepts the message. Add
`--wait` to block until the agent stops, then print its reply and anything it is
waiting on. A message sent while the agent is busy runs as the next turn.

`new` uses the project's default model and permission mode. Override them with
`--model <provider-instance>/<model>`, `--runtime-mode`, and `--mode plan`.
`--worktree <base-branch>` runs the thread in a new git worktree, like choosing
a worktree in the composer.

## Statuses

`list`, `show`, and `wait` report one status: `queued`, `starting`, `running`,
`waiting_for_approval`, `waiting_for_input`, `completed`, `failed`,
`interrupted`, or `idle`. `wait` returns on anything other than `queued`,
`starting`, and `running`.

## Approvals and questions

When a thread is `waiting_for_approval`, `t3 thread approve <thread>` accepts
the oldest pending request. Use `--decision decline` (or `acceptForSession`,
`acceptAlways`, `cancel`) and `--request <id>` to choose.

When it is `waiting_for_input`, answer with
`t3 thread answer <thread> <question-id>=<answer>`. A request with a single
question accepts a bare answer. `--dismiss` closes a question the agent asked
without blocking on it. `show` lists the request and question ids.

## Organize threads

`rename`, `pin`/`unpin`, `snooze <thread> <duration>`/`unsnooze`,
`settle`/`unsettle`, `archive`/`unarchive`, `stop`, and `delete` work like their
counterparts in the sidebar.

## Terminals

Each thread has its own terminals, opened in the thread's worktree or project
folder. `--terminal <id>` picks one (default `term-1`).

| Task                               | Command                                         |
| ---------------------------------- | ----------------------------------------------- |
| List terminals and what they run   | `t3 terminal list [--thread <thread>]`          |
| Run a command and print its output | `t3 terminal run <thread> "<command>"`          |
| Type into a terminal               | `t3 terminal write <thread> "<text>"`           |
| Print recent scrollback            | `t3 terminal read <thread> [--lines 200]`       |
| Use a terminal interactively       | `t3 terminal attach <thread>`                   |
| Open, clear, restart, or close     | `t3 terminal open/clear/restart/close <thread>` |

`run` prints output until the terminal is quiet for `--idle` (default 2s), so
long-running commands are better started with `write` and checked with `read`.
`attach` connects your terminal to it; press Ctrl-] to detach. Output is plain
text unless you pass `--raw`.

## Everything else

`t3 rpc` calls any server method directly — the same ones the apps use for
git, pull requests, settings, providers, files, and more.

| Task                               | Command                                 |
| ---------------------------------- | --------------------------------------- |
| List methods (optionally filtered) | `t3 rpc list [git]`                     |
| Show a method's payload and result | `t3 rpc describe <method>`              |
| Call a method                      | `t3 rpc call <method> '<json-payload>'` |

Methods that stream print one JSON event per line until they end; `--limit`
and `--timeout` stop them sooner.
