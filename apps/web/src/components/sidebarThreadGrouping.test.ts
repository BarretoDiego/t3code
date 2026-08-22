import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../providerInstances";
import {
  buildSidebarThreadGroups,
  deriveSidebarProviderOptions,
  flattenSidebarThreadGroups,
  resolveThreadProviderIdentity,
  settledShelfKey,
  type GroupableThread,
  type SidebarThreadGroupContext,
  type SidebarThreadGroupRow,
} from "./sidebarThreadGrouping";

interface TestThread extends GroupableThread {
  readonly id: string;
}

/** One rendering of every row kind, so a test reads as the list the user sees. */
function formatRow(row: SidebarThreadGroupRow<TestThread>): string {
  switch (row.kind) {
    case "header":
      return `H:${row.group.label}`;
    case "thread":
      return `T:${row.thread.id}`;
    case "settled-header":
      return `S:${row.group.label}(${row.group.settledThreads.length})${row.expanded ? "+" : "-"}`;
    case "settled-thread":
      return `s:${row.thread.id}`;
    case "settled-more":
      return `S+${row.hiddenCount}`;
  }
}

function providerEntry(input: {
  instanceId: string;
  driverKind: string;
  displayName: string;
  isDefault?: boolean;
}): ProviderInstanceEntry {
  return {
    instanceId: input.instanceId,
    driverKind: input.driverKind,
    displayName: input.displayName,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: input.isDefault ?? true,
    isAvailable: true,
    snapshot: {},
    models: [],
  } as unknown as ProviderInstanceEntry;
}

const PROVIDERS: SidebarThreadGroupContext["providerEntriesByEnvironment"] = new Map([
  [
    "local",
    new Map([
      [
        "claude",
        providerEntry({ instanceId: "claude", driverKind: "claude", displayName: "Claude" }),
      ],
      ["codex", providerEntry({ instanceId: "codex", driverKind: "codex", displayName: "Codex" })],
      [
        "claude-work",
        providerEntry({
          instanceId: "claude-work",
          driverKind: "claude",
          displayName: "Claude (work)",
          isDefault: false,
        }),
      ],
    ]),
  ],
  [
    "remote",
    new Map([
      [
        "claude",
        providerEntry({ instanceId: "claude", driverKind: "claude", displayName: "Claude" }),
      ],
    ]),
  ],
]);

const CONTEXT: SidebarThreadGroupContext = {
  resolveEnvironmentLabel: (environmentId) => (environmentId === "remote" ? "Remote box" : null),
  resolveProjectLabel: (environmentId, projectId) =>
    projectId === "ghost" ? null : `${environmentId}/${projectId}`,
  providerEntriesByEnvironment: PROVIDERS,
};

const environmentId = (value: string): EnvironmentId => value as EnvironmentId;
const projectId = (value: string): ProjectId => value as ProjectId;

function thread(input: {
  id: string;
  environmentId?: string;
  projectId?: string;
  instanceId?: string;
  sessionInstanceId?: string;
}): TestThread {
  return {
    id: input.id,
    environmentId: environmentId(input.environmentId ?? "local"),
    projectId: projectId(input.projectId ?? "app"),
    modelSelection: { instanceId: input.instanceId ?? "claude" },
    session:
      input.sessionInstanceId === undefined
        ? null
        : { providerInstanceId: input.sessionInstanceId },
  };
}

describe("resolveThreadProviderIdentity", () => {
  it("prefers the live session instance over the configured model selection", () => {
    const identity = resolveThreadProviderIdentity(
      thread({ id: "a", instanceId: "claude", sessionInstanceId: "codex" }),
      PROVIDERS,
    );
    expect(identity).toEqual({ driverKind: "codex", label: "Codex" });
  });

  it("falls back to the model selection when there is no live session", () => {
    expect(
      resolveThreadProviderIdentity(thread({ id: "a", instanceId: "codex" }), PROVIDERS),
    ).toEqual({ driverKind: "codex", label: "Codex" });
  });

  it("keeps threads on unknown providers groupable instead of dropping them", () => {
    expect(
      resolveThreadProviderIdentity(thread({ id: "a", instanceId: "deleted" }), PROVIDERS),
    ).toEqual({ driverKind: "unknown", label: "Unknown provider" });
  });

  it("labels non-default instances by driver so instances of one driver share a section", () => {
    const identity = resolveThreadProviderIdentity(
      thread({ id: "a", instanceId: "claude-work" }),
      PROVIDERS,
    );
    expect(identity).toEqual({ driverKind: "claude", label: "Claude" });
  });
});

describe("deriveSidebarProviderOptions", () => {
  it("lists each driver once, in first-appearance order", () => {
    const options = deriveSidebarProviderOptions(
      [
        thread({ id: "a", instanceId: "codex" }),
        thread({ id: "b", instanceId: "claude" }),
        thread({ id: "c", instanceId: "claude-work" }),
      ],
      PROVIDERS,
    );
    expect(options.map((option) => option.driverKind)).toEqual(["codex", "claude"]);
  });
});

describe("buildSidebarThreadGroups", () => {
  it("returns no groups when grouping is off, so the caller renders a flat list", () => {
    expect(
      buildSidebarThreadGroups({
        threads: [thread({ id: "a" })],
        primaryAxis: "none",
        secondaryAxis: "project",
        context: CONTEXT,
      }),
    ).toEqual([]);
  });

  it("groups by environment and falls back to a local label", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "a", environmentId: "local" }),
        thread({ id: "b", environmentId: "remote" }),
        thread({ id: "c", environmentId: "local" }),
      ],
      primaryAxis: "environment",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => [group.label, group.threadCount])).toEqual([
      ["This computer", 2],
      ["Remote box", 1],
    ]);
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("preserves incoming thread order inside each section", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "c", projectId: "app" }),
        thread({ id: "a", projectId: "api" }),
        thread({ id: "b", projectId: "app" }),
      ],
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => group.threads.map((t) => t.id))).toEqual([["c", "b"], ["a"]]);
  });

  it("nests the secondary axis under the primary one", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "a", environmentId: "local", projectId: "app" }),
        thread({ id: "b", environmentId: "local", projectId: "api" }),
        thread({ id: "c", environmentId: "remote", projectId: "app" }),
      ],
      primaryAxis: "environment",
      secondaryAxis: "project",
      context: CONTEXT,
    });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.threads).toEqual([]);
    expect(groups[0]!.threadCount).toBe(2);
    expect(groups[0]!.children.map((child) => [child.label, child.threadCount])).toEqual([
      ["local/app", 1],
      ["local/api", 1],
    ]);
  });

  it("scopes child keys by parent so the same bucket collapses independently", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "a", environmentId: "local", instanceId: "claude" }),
        thread({ id: "b", environmentId: "remote", instanceId: "claude" }),
      ],
      primaryAxis: "environment",
      secondaryAxis: "provider",
      context: CONTEXT,
    });
    expect(groups[0]!.children[0]!.key).toBe("environment:local/provider:claude");
    expect(groups[1]!.children[0]!.key).toBe("environment:remote/provider:claude");
  });

  it("ignores a secondary axis identical to the primary instead of nesting single children", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a" }), thread({ id: "b" })],
      primaryAxis: "project",
      secondaryAxis: "project",
      context: CONTEXT,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.children).toEqual([]);
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("labels projects that cannot be resolved instead of dropping their threads", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a", projectId: "ghost" })],
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups[0]!.label).toBe("Unknown project");
  });
});

describe("attention rollup", () => {
  const classify = (thread: GroupableThread) => {
    const id = (thread as TestThread).id;
    if (id.startsWith("approval")) return "approval" as const;
    if (id.startsWith("unread")) return "unread" as const;
    if (id.startsWith("working")) return "working" as const;
    return null;
  };

  it("stays all-zero when no classifier is provided", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "approval-1" })],
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups[0]!.attention).toEqual({
      approval: 0,
      input: 0,
      failed: 0,
      unread: 0,
      working: 0,
    });
  });

  it("counts each attention class per section", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "approval-1", projectId: "app" }),
        thread({ id: "unread-1", projectId: "app" }),
        thread({ id: "unread-2", projectId: "app" }),
        thread({ id: "quiet", projectId: "app" }),
        thread({ id: "working-1", projectId: "api" }),
      ],
      primaryAxis: "project",
      secondaryAxis: "none",
      context: { ...CONTEXT, classifyAttention: classify },
    });
    expect(groups[0]!.attention).toMatchObject({ approval: 1, unread: 2, working: 0 });
    expect(groups[1]!.attention).toMatchObject({ approval: 0, unread: 0, working: 1 });
  });

  it("rolls nested sections up into their parent", () => {
    const groups = buildSidebarThreadGroups({
      threads: [
        thread({ id: "approval-1", environmentId: "local", projectId: "app" }),
        thread({ id: "unread-1", environmentId: "local", projectId: "api" }),
      ],
      primaryAxis: "environment",
      secondaryAxis: "project",
      context: { ...CONTEXT, classifyAttention: classify },
    });
    expect(groups[0]!.attention).toMatchObject({ approval: 1, unread: 1 });
    expect(groups[0]!.children[0]!.attention).toMatchObject({ approval: 1, unread: 0 });
    expect(groups[0]!.children[1]!.attention).toMatchObject({ approval: 0, unread: 1 });
  });
});

describe("flattenSidebarThreadGroups", () => {
  const groups = buildSidebarThreadGroups({
    threads: [
      thread({ id: "a", environmentId: "local", projectId: "app" }),
      thread({ id: "b", environmentId: "local", projectId: "api" }),
      thread({ id: "c", environmentId: "remote", projectId: "app" }),
    ],
    primaryAxis: "environment",
    secondaryAxis: "project",
    context: CONTEXT,
  });

  it("emits headers and threads depth-first when nothing is collapsed", () => {
    const rows = flattenSidebarThreadGroups(groups, new Set());
    expect(rows.map((row) => `${formatRow(row)}@${row.depth}`)).toEqual([
      "H:This computer@0",
      "H:local/app@1",
      "T:a@2",
      "H:local/api@1",
      "T:b@2",
      "H:Remote box@0",
      "H:remote/app@1",
      "T:c@2",
    ]);
  });

  it("collapses a parent to a single row, hiding nested headers too", () => {
    const rows = flattenSidebarThreadGroups(groups, new Set(["environment:local"]));
    expect(rows.map(formatRow)).toEqual(["H:This computer", "H:Remote box", "H:remote/app", "T:c"]);
  });

  it("collapses a child without touching its siblings", () => {
    const rows = flattenSidebarThreadGroups(
      groups,
      new Set(["environment:local/project:local:app"]),
    );
    expect(rows.map(formatRow)).toEqual([
      "H:This computer",
      "H:local/app",
      "H:local/api",
      "T:b",
      "H:Remote box",
      "H:remote/app",
      "T:c",
    ]);
  });
});

describe("sections that outlive their threads", () => {
  const seeds = [
    { environmentId: environmentId("local"), projectId: projectId("app") },
    { environmentId: environmentId("local"), projectId: projectId("quiet") },
    { environmentId: environmentId("remote"), projectId: projectId("app") },
  ];

  it("keeps a row for a project with no threads at all", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a", environmentId: "local", projectId: "app" })],
      seeds,
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => group.label)).toEqual(["local/app", "local/quiet", "remote/app"]);
    const quiet = groups.find((group) => group.label === "local/quiet");
    expect(quiet?.threadCount).toBe(0);
    // Without this the header could not offer New thread: there is no thread
    // to read the project off of.
    expect(quiet?.target).toEqual({
      environmentId: environmentId("local"),
      projectId: projectId("quiet"),
    });
  });

  it("sorts sections with live work above history-only above empty", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a", environmentId: "remote", projectId: "app" })],
      settledThreads: [thread({ id: "old", environmentId: "local", projectId: "app" })],
      seeds,
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => group.label)).toEqual(["remote/app", "local/app", "local/quiet"]);
  });

  it("builds sections from seeds alone when nothing has run yet", () => {
    const groups = buildSidebarThreadGroups({
      threads: [],
      seeds,
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups).toHaveLength(3);
  });

  it("seeds nested project sections under the environment they belong to", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a", environmentId: "local", projectId: "app" })],
      seeds,
      primaryAxis: "environment",
      secondaryAxis: "project",
      context: CONTEXT,
    });
    expect(
      groups.map((group) => [group.label, group.children.map((child) => child.label)]),
    ).toEqual([
      ["This computer", ["local/app", "local/quiet"]],
      ["Remote box", ["remote/app"]],
    ]);
  });

  it("never seeds a provider section: a project has no provider until it runs", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "a", instanceId: "claude" })],
      seeds,
      primaryAxis: "provider",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => group.label)).toEqual(["Claude"]);
  });
});

describe("history inside a section", () => {
  const build = (settledIds: ReadonlyArray<string>) =>
    buildSidebarThreadGroups({
      threads: [thread({ id: "live", environmentId: "local", projectId: "app" })],
      settledThreads: settledIds.map((id) =>
        thread({ id, environmentId: "local", projectId: "app" }),
      ),
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });

  it("counts history apart from live work", () => {
    const [group] = build(["old1", "old2"]);
    expect(group?.threadCount).toBe(1);
    expect(group?.settledCount).toBe(2);
  });

  it("starts closed and opens only the shelf that was asked for", () => {
    const groups = build(["old1", "old2"]);
    expect(flattenSidebarThreadGroups(groups, new Set()).map(formatRow)).toEqual([
      "H:local/app",
      "T:live",
      "S:local/app(2)-",
    ]);
    const shelfKey = settledShelfKey("project:local:app");
    expect(
      flattenSidebarThreadGroups(groups, new Set(), {
        expandedSettledKeys: new Set([shelfKey]),
      }).map(formatRow),
    ).toEqual(["H:local/app", "T:live", "S:local/app(2)+", "s:old1", "s:old2"]);
  });

  it("keeps history behind the section's own collapse", () => {
    const groups = build(["old1"]);
    expect(
      flattenSidebarThreadGroups(groups, new Set(["project:local:app"]), {
        expandedSettledKeys: new Set([settledShelfKey("project:local:app")]),
      }).map(formatRow),
    ).toEqual(["H:local/app"]);
  });

  it("pages a long history and offers the rest in one go", () => {
    const groups = build(["o1", "o2", "o3", "o4"]);
    const shelfKey = settledShelfKey("project:local:app");
    const expandedSettledKeys = new Set([shelfKey]);
    expect(
      flattenSidebarThreadGroups(groups, new Set(), {
        expandedSettledKeys,
        settledPageSize: 2,
      }).map(formatRow),
    ).toEqual(["H:local/app", "T:live", "S:local/app(4)+", "s:o1", "s:o2", "S+2"]);
    expect(
      flattenSidebarThreadGroups(groups, new Set(), {
        expandedSettledKeys,
        settledPageSize: 2,
        fullSettledKeys: new Set([shelfKey]),
      }).map(formatRow),
    ).toEqual(["H:local/app", "T:live", "S:local/app(4)+", "s:o1", "s:o2", "s:o3", "s:o4"]);
  });

  it("pushes history down to the leaf section when nesting", () => {
    const groups = buildSidebarThreadGroups({
      threads: [thread({ id: "live", environmentId: "local", projectId: "app" })],
      settledThreads: [thread({ id: "old", environmentId: "local", projectId: "app" })],
      primaryAxis: "environment",
      secondaryAxis: "project",
      context: CONTEXT,
    });
    // The environment header rolls the count up but owns no rows of its own,
    // or the same thread would render under both headers.
    expect(groups[0]?.settledCount).toBe(1);
    expect(groups[0]?.settledThreads).toEqual([]);
    expect(
      flattenSidebarThreadGroups(groups, new Set(), {
        expandedSettledKeys: new Set([settledShelfKey("environment:local/project:local:app")]),
      }).map(formatRow),
    ).toEqual(["H:This computer", "H:local/app", "T:live", "S:local/app(1)+", "s:old"]);
  });

  it("gives a project that only has history a section of its own", () => {
    const groups = buildSidebarThreadGroups({
      threads: [],
      settledThreads: [thread({ id: "old", environmentId: "local", projectId: "archived" })],
      primaryAxis: "project",
      secondaryAxis: "none",
      context: CONTEXT,
    });
    expect(groups.map((group) => group.label)).toEqual(["local/archived"]);
    expect(groups[0]?.threadCount).toBe(0);
  });
});
