import type { ExecutionNode, ExecutionNodeTransport, JobAction } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { baseSshArgs, resolveSshCommand, runSshCommand } from "@t3tools/ssh/command";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { quoteRemoteArg } from "../../device/sshDeviceScript.ts";

export class JobExecutorError extends Schema.TaggedError<JobExecutorError>()("JobExecutorError", {
  step: Schema.Literals(["resolve", "start", "probe"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface JobSpec {
  readonly node: ExecutionNode;
  /** Already resolved and checked against the node's workspace roots. */
  readonly cwd: string;
  readonly action: JobAction;
  /** Added to the minimal environment. Never the server's own environment. */
  readonly env: Readonly<Record<string, string>>;
}

export interface RunningJob {
  /** Names the process so its state can be checked after this server restarts. */
  readonly ref: string;
  /** Standard output and error, interleaved. Ends when the process closes them. */
  readonly output: Stream.Stream<Uint8Array>;
  /** The process's real exit: its code, or null when a signal ended it. */
  readonly exit: Effect.Effect<{ readonly code: number | null }>;
  /** Asks the process to stop and returns once it has. */
  readonly kill: Effect.Effect<void>;
}

/** What can still be established about a process this server no longer holds. */
export type JobProcessState = "running" | "gone" | "unverifiable";

export interface NodeProbe {
  readonly os: string;
  readonly arch: string;
  readonly tools: ReadonlyArray<{ readonly name: string; readonly version: string | null }>;
}

/** The process boundary of jobs: the server's own machine and machines reached over SSH. */
export class JobExecutor extends Context.Service<
  JobExecutor,
  {
    /** The real path of a directory on the node, after following symlinks. */
    readonly resolveDirectory: (
      node: ExecutionNode,
      directory: string,
    ) => Effect.Effect<string, JobExecutorError>;
    /** The process lives until the scope closes; closing the scope kills it. */
    readonly start: (spec: JobSpec) => Effect.Effect<RunningJob, JobExecutorError, Scope.Scope>;
    readonly inspect: (node: ExecutionNode, ref: string) => Effect.Effect<JobProcessState>;
    readonly probe: (node: ExecutionNode) => Effect.Effect<NodeProbe, JobExecutorError>;
  }
>()("t3/automation/jobs/JobExecutor") {}

const PROBED_TOOLS = ["git", "node"] as const;
/** The only variables a job inherits from the server process. */
const INHERITED_ENVIRONMENT = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"];
const SSH_TIMEOUT_MS = 30_000;

type SshTransport = Extract<ExecutionNodeTransport, { readonly type: "ssh" }>;

const sshTarget = (transport: SshTransport) => ({
  alias: transport.target,
  hostname: transport.target,
  username: null,
  port: transport.port ?? null,
});

const sshIdentityArgs = (transport: SshTransport) =>
  transport.identityFile === undefined ? [] : ["-i", transport.identityFile];

/**
 * The single command line SSH hands to the remote login shell. Every value is
 * quoted, so a `command` action stays a fixed argv; only a `shell` action is
 * interpreted. `env -i` keeps the remote account's exported variables out.
 */
export const remoteJobCommand = (spec: Pick<JobSpec, "cwd" | "action" | "env">): string => {
  const assignments = Object.entries(spec.env).map(
    ([name, value]) => `${name}=${quoteRemoteArg(value)}`,
  );
  const argv =
    spec.action.type === "shell"
      ? ["sh", "-c", spec.action.script]
      : [spec.action.executable, ...spec.action.args];
  return [
    `cd ${quoteRemoteArg(spec.cwd)}`,
    `exec env -i PATH="$PATH" HOME="$HOME" ${[...assignments, ...argv.map(quoteRemoteArg)].join(" ")}`,
  ].join(" && ");
};

/** `ssh` arguments for a job on an SSH node. Never prompts: a job has no terminal. */
export const sshJobArgs = (
  transport: SshTransport,
  spec: Pick<JobSpec, "cwd" | "action" | "env">,
) => [
  ...baseSshArgs(sshTarget(transport), { batchMode: "yes" }),
  ...sshIdentityArgs(transport),
  transport.target,
  remoteJobCommand(spec),
];

const firstLine = (text: string) => text.split(/\r?\n/u)[0]?.trim() ?? "";

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const sshCommand = yield* resolveSshCommand;
  const provideSsh = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >,
  ) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const minimalEnvironment = (extra: Readonly<Record<string, string>>) => ({
    ...Object.fromEntries(
      INHERITED_ENVIRONMENT.flatMap((name) => {
        const value = hostEnvironment[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    ),
    ...extra,
  });

  const failed = (step: JobExecutorError["step"], detail: string) =>
    new JobExecutorError({ step, detail });

  /** Runs a short command on the node and returns the first line it printed. */
  const capture = (
    node: ExecutionNode,
    command: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<string, JobExecutorError> =>
    node.transport.type === "ssh"
      ? runSshCommand(sshTarget(node.transport), {
          preHostArgs: sshIdentityArgs(node.transport),
          remoteCommandArgs: [[command, ...args].map(quoteRemoteArg).join(" ")],
          timeoutMs: SSH_TIMEOUT_MS,
        }).pipe(
          provideSsh,
          Effect.map((result) => firstLine(result.stdout)),
          Effect.mapError((cause) => failed("probe", cause.message)),
        )
      : Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make(command, args, {
                env: minimalEnvironment({}),
                extendEnv: false,
              }),
            );
            const [output, code] = yield* Effect.all(
              [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
              { concurrency: 2 },
            );
            return { output, code: Number(code) };
          }),
        ).pipe(
          Effect.mapError((cause) => failed("probe", cause.message)),
          Effect.flatMap(({ output, code }) =>
            code === 0
              ? Effect.succeed(firstLine(output))
              : Effect.fail(failed("probe", `${command} exited with code ${code}.`)),
          ),
        );

  const resolveDirectory: JobExecutor["Service"]["resolveDirectory"] = (node, directory) => {
    const missing = failed("resolve", `${directory} is not a directory on node ${node.id}.`);
    const resolved: Effect.Effect<string, JobExecutorError> =
      node.transport.type === "ssh"
        ? // `cd -P` resolves symlinks in the remote shell without relying on a realpath binary.
          runSshCommand(sshTarget(node.transport), {
            preHostArgs: sshIdentityArgs(node.transport),
            remoteCommandArgs: [`cd -P ${quoteRemoteArg(directory)} && pwd -P`],
            timeoutMs: SSH_TIMEOUT_MS,
          }).pipe(
            provideSsh,
            Effect.map((result) => firstLine(result.stdout)),
            Effect.mapError(() => missing),
          )
        : fileSystem.realPath(directory).pipe(
            Effect.flatMap((real) =>
              Effect.map(fileSystem.stat(real), (info) => (info.type === "Directory" ? real : "")),
            ),
            Effect.mapError(() => missing),
          );
    return Effect.flatMap(resolved, (real) =>
      real.length > 0 ? Effect.succeed(real) : Effect.fail(missing),
    );
  };

  const start: JobExecutor["Service"]["start"] = Effect.fn("JobExecutor.start")(function* (spec) {
    const transport = spec.node.transport;
    const command =
      transport.type === "ssh"
        ? ChildProcess.make(sshCommand, sshJobArgs(transport, spec), {
            env: minimalEnvironment({}),
            extendEnv: false,
            forceKillAfter: "5 seconds",
          })
        : spec.action.type === "shell"
          ? ChildProcess.make(
              platform === "win32" ? "cmd.exe" : "sh",
              platform === "win32"
                ? ["/d", "/s", "/c", spec.action.script]
                : ["-c", spec.action.script],
              {
                cwd: spec.cwd,
                env: minimalEnvironment(spec.env),
                extendEnv: false,
                forceKillAfter: "5 seconds",
              },
            )
          : // No shell: the executable and its arguments reach the process exactly as given.
            ChildProcess.make(spec.action.executable, spec.action.args, {
              cwd: spec.cwd,
              env: minimalEnvironment(spec.env),
              extendEnv: false,
              shell: false,
              forceKillAfter: "5 seconds",
            });
    const child = yield* spawner.spawn(command).pipe(
      Effect.mapError(
        (cause) =>
          new JobExecutorError({
            step: "start",
            detail: `The process could not be started: ${cause.message}`,
          }),
      ),
    );
    const stdin = spec.action.type === "command" ? spec.action.stdin : undefined;
    // Closing stdin is part of starting: a process reading it must see the end.
    yield* Stream.run(
      stdin === undefined ? Stream.empty : Stream.encodeText(Stream.make(stdin)),
      child.stdin,
    ).pipe(Effect.ignore, Effect.forkScoped);
    const startedAt =
      transport.type === "local" && platform !== "win32"
        ? yield* capture(spec.node, "ps", ["-o", "lstart=", "-p", String(child.pid)]).pipe(
            Effect.orElseSucceed(() => ""),
          )
        : "";
    return {
      ref:
        transport.type === "ssh"
          ? `ssh:${child.pid}`
          : startedAt.length > 0
            ? `pid:${child.pid}:${startedAt}`
            : `pid:${child.pid}`,
      output: child.all.pipe(Stream.catchCause(() => Stream.empty)),
      exit: child.exitCode.pipe(
        Effect.map((code) => ({ code: Number(code) })),
        // The spawner reports death by signal as a failure: there is no exit code to give.
        Effect.orElseSucceed(() => ({ code: null })),
      ),
      kill: child.kill().pipe(Effect.ignore),
    } satisfies RunningJob;
  });

  const inspect: JobExecutor["Service"]["inspect"] = (node, ref) => {
    // Only a local process recorded with its start time can be told apart from
    // an unrelated process that later got the same pid.
    const match = /^pid:(\d+):(.+)$/u.exec(ref);
    if (node.transport.type !== "local" || match === null || platform === "win32") {
      return Effect.succeed("unverifiable");
    }
    return capture(node, "ps", ["-o", "lstart=", "-p", match[1]!]).pipe(
      Effect.map((startedAt): JobProcessState => (startedAt === match[2] ? "running" : "gone")),
      Effect.orElseSucceed((): JobProcessState => "gone"),
    );
  };

  const probe: JobExecutor["Service"]["probe"] = Effect.fn("JobExecutor.probe")(function* (node) {
    const identity: Pick<NodeProbe, "os" | "arch"> =
      node.transport.type === "ssh"
        ? yield* Effect.all({
            os: capture(node, "uname", ["-s"]),
            arch: capture(node, "uname", ["-m"]),
          })
        : { os: platform, arch: architecture };
    const tools = yield* Effect.forEach(
      PROBED_TOOLS,
      (name) =>
        capture(node, name, ["--version"]).pipe(
          Effect.map((version) => ({ name, version: version.length > 0 ? version : null })),
          Effect.orElseSucceed(() => ({ name, version: null })),
        ),
      { concurrency: 2 },
    );
    return { ...identity, tools };
  });

  return JobExecutor.of({ resolveDirectory, start, inspect, probe });
});

/** Needs `ChildProcessSpawner`, `FileSystem` and `Path`. */
export const layer = Layer.effect(JobExecutor, make);
