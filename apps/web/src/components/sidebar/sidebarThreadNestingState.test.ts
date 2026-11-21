import {
  buildThreadNesting,
  type ThreadNestingThread,
} from "@t3tools/client-runtime/state/thread-nesting";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sameNestedChildren } from "./sidebarThreadNestingState";

function shell(
  id: string,
  parent: string | null,
  status: "running" | "completed",
): ThreadNestingThread {
  return {
    environmentId: "env",
    id,
    createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
    archivedAt: null,
    lineage: {
      rootThreadId: ThreadId.make(parent ?? id),
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent: parent === null ? null : "subagent",
    },
    forkedFrom: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: { status },
  };
}

function root(threads: ReadonlyArray<ThreadNestingThread>) {
  return buildThreadNesting({ threads, isListed: () => true }).roots[0]!;
}

describe("sameNestedChildren", () => {
  const parent = shell("p", null, "completed");
  const child = shell("pc", "p", "completed");

  it("ignores changes to the parent's own shell", () => {
    expect(
      sameNestedChildren(root([parent, child]), root([shell("p", null, "running"), child])),
    ).toBe(true);
  });

  it("notices a child's new shell, a new child, and a new grandchild", () => {
    const before = root([parent, child]);
    expect(sameNestedChildren(before, root([parent, shell("pc", "p", "running")]))).toBe(false);
    expect(sameNestedChildren(before, root([parent, child, shell("pd", "p", "completed")]))).toBe(
      false,
    );
    expect(sameNestedChildren(before, root([parent, child, shell("pcg", "pc", "completed")]))).toBe(
      false,
    );
  });
});
