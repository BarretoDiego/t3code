import { describe, expect, it } from "@effect/vitest";

import {
  resolveAgentBoardActionAvailability,
  resolveAgentBoardPageState,
} from "./AgentBoardPage.logic";

describe("AgentBoardPage logic", () => {
  it("does not show definitive empty before partial bootstrap resolves", () => {
    expect(
      resolveAgentBoardPageState({ bootstrapped: false, shellCount: 0, visibleCount: 0 }),
    ).toBe("loading");
    expect(
      resolveAgentBoardPageState({ bootstrapped: false, shellCount: 2, visibleCount: 0 }),
    ).toBe("empty");
    expect(resolveAgentBoardPageState({ bootstrapped: true, shellCount: 0, visibleCount: 1 })).toBe(
      "board",
    );
  });

  it("gates runtime and lifecycle actions without pretending resume exists", () => {
    expect(
      resolveAgentBoardActionAvailability({
        runtimeKind: "working",
        connected: true,
        supportsSettlement: true,
        lifecycleSettled: false,
        canSettle: false,
      }),
    ).toEqual({ interrupt: true, archive: false, settle: false, unsettle: false });
    expect(
      resolveAgentBoardActionAvailability({
        runtimeKind: "needs-you",
        connected: true,
        supportsSettlement: true,
        lifecycleSettled: false,
        canSettle: false,
      }),
    ).toEqual({ interrupt: false, archive: false, settle: false, unsettle: false });
    expect(
      resolveAgentBoardActionAvailability({
        runtimeKind: "settled",
        connected: true,
        supportsSettlement: true,
        lifecycleSettled: true,
        canSettle: true,
      }),
    ).toEqual({ interrupt: false, archive: true, settle: false, unsettle: true });
  });

  it("hides every mutating action for cached or disconnected cards", () => {
    expect(
      resolveAgentBoardActionAvailability({
        runtimeKind: "working",
        connected: false,
        supportsSettlement: true,
        lifecycleSettled: false,
        canSettle: true,
      }),
    ).toEqual({ interrupt: false, archive: false, settle: false, unsettle: false });

    expect(
      resolveAgentBoardActionAvailability({
        runtimeKind: "settled",
        connected: false,
        supportsSettlement: true,
        lifecycleSettled: true,
        canSettle: true,
      }),
    ).toEqual({ interrupt: false, archive: false, settle: false, unsettle: false });
  });
});
