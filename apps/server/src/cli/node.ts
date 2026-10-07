/**
 * `t3 node` - the machines an environment can run jobs on.
 *
 * Every environment has the built-in `local` node, its server's own machine.
 * Other nodes are reached over SSH. A node runs nothing until it has workspace
 * roots, and a shell line only if it allows shell.
 */
import {
  AUTOMATION_WS_METHODS,
  type ExecutionNode,
  ExecutionNodeId,
  IdempotencyKey,
  JobSubmitInput,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { jsonFlag, printJson, timeoutFlag, withClient } from "./common.ts";
import { type EnvironmentRpcClient, environmentTargetFlags } from "./environmentRpc.ts";
import { reportWaited, waitForJob } from "./job.ts";

const M = AUTOMATION_WS_METHODS;

export class NodeCliError extends Schema.TaggedError<NodeCliError>()("NodeCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) => Effect.fail(new NodeCliError({ detail }));

/**
 * A job file is a submit request without the node, which the command line
 * names. The idempotency key may be left out for a one-off run.
 */
const JobFile = Schema.Struct({
  ...JobSubmitInput.mapFields(({ nodeId: _nodeId, idempotencyKey: _key, ...rest }) => rest).fields,
  idempotencyKey: Schema.optional(IdempotencyKey),
});
const decodeJobFile = Schema.decodeUnknownEffect(Schema.fromJsonString(JobFile));

export const parseJobFile = (text: string) =>
  decodeJobFile(text).pipe(
    Effect.mapError(
      () =>
        new NodeCliError({
          detail:
            'The job file must be JSON like {"cwd": "/abs/path", "action": {"type": "command", "executable": "npm", "args": ["test"]}}. Optional: idempotencyKey, timeoutMs, idempotent, taskId, threadId, orchestratorId. A shell line is {"type": "shell", "script": "..."}.',
        }),
    ),
  );

const loadNodes = (client: EnvironmentRpcClient) =>
  Effect.map(client[M.nodesList]({}), (result) => result.nodes);

/** Resolves a node by id, unique id prefix, or exact label. */
const resolveNode = Effect.fn("cli.node.resolveNode")(function* (
  client: EnvironmentRpcClient,
  identifier: string,
) {
  const wanted = identifier.trim();
  const nodes = yield* loadNodes(client);
  const matches = [
    nodes.filter((node) => node.id === wanted),
    nodes.filter((node) => wanted.length > 0 && node.id.startsWith(wanted)),
    nodes.filter((node) => node.label.toLowerCase() === wanted.toLowerCase()),
  ].find((candidates) => candidates.length > 0);
  if (matches?.length === 1) return matches[0]!;
  return yield* fail(
    matches === undefined
      ? `No node matches '${wanted}'. Run \`t3 node list\` to see them.`
      : `'${wanted}' matches ${matches.length} nodes: ${matches.map((node) => node.id).join(", ")}. Use its id.`,
  );
});

function describeTransport(node: ExecutionNode): string {
  if (node.transport.type === "local") return "this machine";
  return `ssh ${node.transport.target}${node.transport.port === undefined ? "" : `:${node.transport.port}`}`;
}

/** The last probe is a snapshot with its time, never a promise about the next job. */
function describeAvailability(node: ExecutionNode): string {
  const seen = node.availability;
  if (seen.observedAt === null) return "not probed";
  const detail =
    seen.status === "available"
      ? [seen.os, seen.arch].filter((part) => part !== null).join("/")
      : (seen.error ?? "no detail");
  return `${seen.status} as of ${seen.observedAt}${detail.length === 0 ? "" : ` (${detail})`}`;
}

export function formatNodeLine(node: ExecutionNode): string {
  return [
    node.id,
    node.label,
    describeTransport(node),
    node.enabled ? "enabled" : "disabled",
    describeAvailability(node),
  ].join("  ");
}

export function formatNode(node: ExecutionNode): string {
  return [
    `${node.label} (${node.id})`,
    `  transport:  ${describeTransport(node)}`,
    `  enabled:    ${node.enabled ? "yes" : "no"}`,
    `  workspaces: ${node.workspaceRoots.join(", ") || "none - no job can run here yet"}`,
    `  shell:      ${node.allowShell ? "allowed (callers still need the automation:execute scope)" : "not allowed"}`,
    `  last probe: ${describeAvailability(node)}`,
    ...node.availability.tools.map(
      (tool) => `  ${`${tool.name}:`.padEnd(11)} ${tool.version ?? "not found"}`,
    ),
  ].join("\n");
}

const nodeArgument = Argument.String("node").pipe(
  Argument.withDescription("Node id, unique id prefix, or label. The server's machine is `local`."),
);

const rootFlag = Flag.String("root").pipe(
  Flag.withDescription("Directory jobs may run in. Repeat for several."),
  Flag.atLeast(0),
);

const printNode = (node: ExecutionNode, json: boolean) =>
  json ? printJson(node) : Console.log(formatNode(node));

const listCommand = Command.make("list", { ...environmentTargetFlags, json: jsonFlag }).pipe(
  Command.withDescription("List execution nodes with their last probe."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.list")(function* (client, flags) {
        const nodes = yield* loadNodes(client);
        if (flags.json) return yield* printJson(nodes);
        yield* Console.log(nodes.map(formatNodeLine).join("\n"));
      }),
    ),
  ),
);

const addCommand = Command.make("add", {
  ...environmentTargetFlags,
  label: Argument.String("label").pipe(Argument.withDescription("What to call the node.")),
  ssh: Flag.String("ssh").pipe(
    Flag.withDescription("SSH destination: a host, user@host, or an alias from ~/.ssh/config."),
  ),
  port: Flag.Int("port").pipe(Flag.withDescription("SSH port."), Flag.optional),
  identityFile: Flag.String("identity-file").pipe(
    Flag.withDescription("Absolute path of the SSH private key on the server's machine."),
    Flag.optional,
  ),
  root: rootFlag,
  allowShell: Flag.Boolean("allow-shell").pipe(
    Flag.withDescription("Let jobs on this node run shell lines."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Add a machine reached over SSH. Key-based login must already work without a prompt.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.add")(function* (client, flags) {
        const node = yield* client[M.nodesUpsert]({
          label: flags.label,
          transport: {
            type: "ssh",
            target: flags.ssh,
            ...(Option.isSome(flags.port) ? { port: flags.port.value } : {}),
            ...(Option.isSome(flags.identityFile)
              ? { identityFile: flags.identityFile.value }
              : {}),
          },
          enabled: true,
          workspaceRoots: flags.root,
          allowShell: flags.allowShell,
        });
        yield* printNode(node, flags.json);
      }),
    ),
  ),
);

const editCommand = Command.make("edit", {
  ...environmentTargetFlags,
  node: nodeArgument,
  label: Flag.String("label").pipe(Flag.withDescription("New label."), Flag.optional),
  root: Flag.String("root").pipe(
    Flag.withDescription("Replace the workspace roots with these. Repeat for several."),
    Flag.atLeast(0),
  ),
  noRoots: Flag.Boolean("no-roots").pipe(
    Flag.withDescription("Remove every workspace root, so no job can run on the node."),
    Flag.withDefault(false),
  ),
  allowShell: Flag.Boolean("allow-shell").pipe(
    Flag.withDescription("Let jobs on this node run shell lines."),
    Flag.withDefault(false),
  ),
  denyShell: Flag.Boolean("deny-shell").pipe(
    Flag.withDescription("Stop jobs on this node from running shell lines."),
    Flag.withDefault(false),
  ),
  enable: Flag.Boolean("enable").pipe(
    Flag.withDescription("Accept jobs on this node."),
    Flag.withDefault(false),
  ),
  disable: Flag.Boolean("disable").pipe(
    Flag.withDescription("Refuse new jobs on this node. Running ones continue."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change a node's label, workspace roots, shell permission, or enabled state.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.edit")(function* (client, flags) {
        if (
          (flags.allowShell && flags.denyShell) ||
          (flags.enable && flags.disable) ||
          (flags.noRoots && flags.root.length > 0)
        ) {
          return yield* fail(
            "Pass only one of each pair: --allow-shell/--deny-shell, --enable/--disable, --root/--no-roots.",
          );
        }
        const node = yield* resolveNode(client, flags.node);
        const updated = yield* client[M.nodesUpsert]({
          id: node.id,
          label: Option.getOrElse(flags.label, () => node.label),
          transport: node.transport,
          enabled: flags.enable ? true : flags.disable ? false : node.enabled,
          workspaceRoots: flags.noRoots
            ? []
            : flags.root.length > 0
              ? flags.root
              : node.workspaceRoots,
          allowShell: flags.allowShell ? true : flags.denyShell ? false : node.allowShell,
        });
        yield* printNode(updated, flags.json);
      }),
    ),
  ),
);

const removeCommand = Command.make("remove", {
  ...environmentTargetFlags,
  node: nodeArgument,
}).pipe(
  Command.withDescription("Remove an SSH node. Refused while it has jobs in flight."),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.remove")(function* (client, flags) {
        const node = yield* resolveNode(client, flags.node);
        yield* client[M.nodesRemove]({ nodeId: node.id });
        yield* Console.log(`Removed ${node.label} (${node.id}).`);
      }),
    ),
  ),
);

const probeCommand = Command.make("probe", {
  ...environmentTargetFlags,
  node: nodeArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Check a node now: reachability, OS, and a few tool versions. Records what it saw and when.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.probe")(function* (client, flags) {
        const node = yield* resolveNode(client, flags.node);
        yield* printNode(yield* client[M.nodesProbe]({ nodeId: node.id }), flags.json);
      }),
    ),
  ),
);

const execCommand = Command.make("exec", {
  ...environmentTargetFlags,
  node: nodeArgument,
  file: Flag.String("file").pipe(
    Flag.withDescription("JSON job file, or - for stdin. See `t3 guide` for its fields."),
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Follow the job to its end and exit non-zero unless it succeeded."),
    Flag.withDefault(false),
  ),
  timeout: timeoutFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Submit a job to the named node and print its id. The job outlives this command; --wait only watches it.",
  ),
  Command.withHandler(
    withClient(
      Effect.fn("cli.node.exec")(function* (client, flags) {
        const text =
          flags.file === "-"
            ? yield* (yield* Stdio.Stdio).stdin.pipe(Stream.decodeText(), Stream.mkString)
            : yield* (yield* FileSystem.FileSystem)
                .readFileString(flags.file)
                .pipe(
                  Effect.mapError(() => new NodeCliError({ detail: `Cannot read ${flags.file}.` })),
                );
        const file = yield* parseJobFile(text);
        const node = yield* resolveNode(client, flags.node);
        const { idempotencyKey, ...request } = file;
        const { job, created } = yield* client[M.jobsSubmit]({
          ...request,
          nodeId: ExecutionNodeId.make(node.id),
          idempotencyKey:
            idempotencyKey ??
            IdempotencyKey.make(`cli-${yield* (yield* Crypto.Crypto).randomUUIDv4}`),
        });
        if (flags.wait) {
          return yield* reportWaited(yield* waitForJob(client, job.id, flags.timeout), flags.json);
        }
        if (flags.json) return yield* printJson({ job, created });
        // The id alone on stdout, so a script can capture it.
        yield* Console.log(job.id);
        yield* Console.error(
          created
            ? `Accepted on ${node.id}. Follow it with \`t3 job wait ${job.id}\` or \`t3 job logs ${job.id} --follow\`.`
            : `Already submitted with this idempotency key; it is ${job.status}.`,
        );
      }),
    ),
  ),
);

export const nodeCommand = Command.make("node").pipe(
  Command.withDescription("Manage execution nodes and run jobs on them."),
  Command.withSubcommands([
    listCommand,
    addCommand,
    editCommand,
    removeCommand,
    probeCommand,
    execCommand,
  ]),
);
