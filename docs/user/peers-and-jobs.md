# Peers, Nodes, and Jobs

Connect two T3 Code environments so they can message each other and hand work across, and run
commands on machines an environment controls. Everything here is driven from the `t3` CLI and keeps
working with every app window closed.

## Peers

A peer is another environment this one talks to directly. There is no service in between: each
environment must be able to reach the other's URL, over your LAN, Tailscale, or a tunnel you
already run. If a peer cannot be reached, messages for it wait and are sent when it returns.

### Connect two environments

Each environment lets the other in separately. To let **A** call **B**:

1. On A, print its id: `t3 peer identity`
2. On B, mint a credential for that id: `t3 peer credential create <A's id> --base-url <B's URL>`
3. On A, add B with the link it printed: `t3 peer add build-box "<link>"`

Repeat the three steps the other way round if B should report back to A, which delegated tasks
need. Use `--session` in step 2 to get a token for `t3 peer add <name> <url> --token <token>`
instead of a one-time link.

A peer credential can only be used by the environment it names and only for peer messages. It does
not let anyone read or control threads, and an ordinary pairing link cannot be used as one.

### Decide what a peer may ask

A new peer may ask for nothing. Give it permissions with a JSON file:

```json
{
  "inbound": ["message.send", "task.delegate"],
  "projectIds": ["<project id>"],
  "forwardEventTypes": ["task.*"]
}
```

`inbound` lists what the peer may ask of this environment. `projectIds` and `nodeIds` narrow where;
leave them out for no narrowing. `forwardEventTypes` lists the event types this environment sends
to the peer. Apply it with `t3 peer add ... --permissions-file <file>` or
`t3 peer update <peer> --permissions-file <file>`. A change applies to messages that are already
waiting: something queued before a permission was removed is refused when it would run.

### See what is happening

- `t3 peer list` shows each link: `connected`, `connecting`, `offline`, `incompatible` (the two
  environments share no protocol version, so nothing is sent), or `revoked` (the peer refuses this
  environment).
- `t3 peer outbox` shows messages still waiting and those rejected, expired, or cancelled.
  `delivered` means the peer stored the message. Whether the work in it was accepted or finished
  arrives later, as a status from the peer.
- `t3 peer disable <peer>` stops sending and refuses the peer's calls without losing what is
  queued. `t3 peer remove <peer>` also deletes its credential and cancels what was waiting.

### Peers in the app

On web and desktop, **Settings → Automation → Peers** lists each environment's peers with their
connection status, when they were last seen, how many messages are waiting to be sent, and what
each peer may ask for. The switch disables a peer without losing what is queued.

- **This environment's ID** is at the top of the list, with a copy button. Give it to the other
  side for step 2 above.
- **Add peer** takes the link the other side printed, or its URL and a token.
- **Edit** changes the name, URL, and permissions. Permissions use the same JSON as above.
- **Remove** also deletes the credential and cancels what was waiting.

Minting a credential for another environment still needs `t3 peer credential create` on the
machine that will be called. Mobile lists peers and their status without editing them.

## Nodes

A node is a machine an environment can run commands on. Every environment has `local`, the machine
its server runs on. Add others over SSH; key-based login must already work without a prompt:

```sh
t3 node add "Build box" --ssh dev@build --root /srv/build
t3 node edit local --root ~/code
t3 node probe "Build box"
```

A node runs nothing until it has a workspace root: jobs may only run inside those directories.
`t3 node probe` records what it saw and when. It is a snapshot, not a promise about the next job.

### Nodes and jobs in the app

On web and desktop, **Settings → Automation → Nodes and jobs** lists each environment's nodes with
their workspace roots, whether shell lines are allowed, and the last probe with its age. **Probe**
takes a new snapshot. Add, edit, or remove nodes there.

**Recent jobs** below shows each job's status and exit code. A job whose exit code was never seen
says so instead of showing zero. **Show log tail** loads the end of its output.

Submitting, cancelling, and reconciling jobs still use the CLI. Mobile lists nodes without editing
them and does not list jobs.

## Jobs

A job is one command on one node. Describe it in a file and submit it:

```json
{ "cwd": "/srv/build/app", "action": { "type": "command", "executable": "npm", "args": ["test"] } }
```

```sh
t3 node exec "Build box" --file job.json          # prints the job id
t3 node exec "Build box" --file job.json --wait   # follows it to the end
t3 job logs <job> --follow
```

The job keeps running after the command that submitted it exits. `t3 job wait` with `--timeout`
stops waiting when the time is up; it does not stop the job. `t3 job cancel` asks the job to stop,
and it shows `cancel_requested` until its process has actually ended.

What is unintuitive:

- A command is an executable and a list of arguments, not a line to be split. For a shell line use
  `{"type": "shell", "script": "..."}`. That needs the node to allow it (`--allow-shell`) and a
  credential with the `automation:execute` scope; administrative access alone is not enough.
- A job gets a minimal environment, not the server's. Pass what it needs as arguments.
- If the server restarts while a job is running, the job becomes `unknown`: its exit code was never
  seen. It is not run again automatically. `t3 job reconcile <job>` re-reads it, and runs it again
  only if the job file said `"idempotent": true`.
- Give a job an `idempotencyKey` if a script might submit it twice. The same key returns the same
  job instead of starting another.
- Output is kept up to a size limit. `t3 job show` says when a log was cut.
