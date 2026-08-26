import type { AgentBoardCard } from "@t3tools/client-runtime/agent-board";

export type AgentBoardPageState = "loading" | "empty" | "board";

export function resolveAgentBoardPageState(input: {
  readonly bootstrapped: boolean;
  readonly shellCount: number;
  readonly visibleCount: number;
}): AgentBoardPageState {
  if (!input.bootstrapped && input.shellCount === 0) return "loading";
  return input.visibleCount === 0 ? "empty" : "board";
}

export interface AgentBoardActionAvailability {
  readonly interrupt: boolean;
  readonly archive: boolean;
  readonly settle: boolean;
  readonly unsettle: boolean;
}

export function resolveAgentBoardActionAvailability(input: {
  readonly runtimeKind: AgentBoardCard["runtime"]["kind"];
  readonly connected: boolean;
  readonly supportsSettlement: boolean;
  readonly lifecycleSettled: boolean;
  readonly canSettle: boolean;
}): AgentBoardActionAvailability {
  const active = input.runtimeKind === "working";
  const attentionBlocked = input.runtimeKind === "needs-you";
  const canQuietAction = input.connected && !active && !attentionBlocked;
  return {
    interrupt: input.connected && active,
    archive: canQuietAction,
    settle:
      canQuietAction && input.supportsSettlement && !input.lifecycleSettled && input.canSettle,
    unsettle: canQuietAction && input.supportsSettlement && input.lifecycleSettled,
  };
}
