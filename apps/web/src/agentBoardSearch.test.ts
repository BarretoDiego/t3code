import { describe, expect, it } from "@effect/vitest";

import {
  encodeAgentBoardFilterList,
  filtersFromAgentBoardSearch,
  parseAgentBoardSearch,
} from "./agentBoardSearch";

describe("agent board URL filters", () => {
  it("round-trips multi-select filters and only-active", () => {
    const search = parseAgentBoardSearch({
      environments: JSON.stringify(["env-a", "env-b", "env-a"]),
      models: JSON.stringify(["gpt-5"]),
      active: "false",
    });
    expect(filtersFromAgentBoardSearch(search)).toMatchObject({
      environmentIds: ["env-a", "env-b"],
      models: ["gpt-5"],
      onlyActive: false,
    });
  });

  it("drops malformed and oversized values", () => {
    expect(
      filtersFromAgentBoardSearch(parseAgentBoardSearch({ projects: "not-json" })).projectKeys,
    ).toEqual([]);
    expect(encodeAgentBoardFilterList([])).toBeUndefined();
  });
});
