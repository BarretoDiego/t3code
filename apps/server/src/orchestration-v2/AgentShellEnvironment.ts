import type { ThreadId } from "@t3tools/contracts";

/**
 * Extra environment for the shell a thread's provider agent runs commands in.
 * Nothing here is a secret: variables name files and directories, and the
 * secret they lead to is read by the tool that needs it.
 */
export interface AgentShellEnvironment {
  readonly variables: Readonly<Record<string, string>>;
  /** A directory placed first on PATH, so its commands win over the user's own. */
  readonly pathEntry: string;
  readonly pathSeparator: string;
}

const environmentsByThread = new Map<ThreadId, AgentShellEnvironment>();

/** Takes effect for provider processes started after the call. */
export function setAgentShellEnvironment(
  threadId: ThreadId,
  environment: AgentShellEnvironment,
): void {
  environmentsByThread.set(threadId, environment);
}

/**
 * The provider process environment for `threadId`: `base` with the thread's
 * agent shell variables applied, or `base` untouched when it has none. Adapters
 * call it where they hand an environment to the process that runs the agent's
 * commands.
 */
export function withAgentShellEnvironment(
  base: NodeJS.ProcessEnv,
  threadId: ThreadId | null | undefined,
): NodeJS.ProcessEnv {
  const extra =
    threadId === null || threadId === undefined ? undefined : environmentsByThread.get(threadId);
  if (extra === undefined) return base;
  const pathKey = base.PATH === undefined && base.Path !== undefined ? "Path" : "PATH";
  const basePath = base[pathKey];
  return {
    ...base,
    ...extra.variables,
    [pathKey]:
      basePath === undefined || basePath === ""
        ? extra.pathEntry
        : `${extra.pathEntry}${extra.pathSeparator}${basePath}`,
  };
}
