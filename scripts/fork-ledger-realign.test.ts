// @effect-diagnostics nodeBuiltinImport:off - Reads the server's migration manifest as text.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  type ColumnFact,
  type LedgerRow,
  planRealign,
  type SchemaFacts,
  UPSTREAM_MIGRATIONS,
} from "./fork-ledger-realign.ts";

// The ledger the old fork left behind: renumbered upstream migrations around fork-only ones.
const FORK_LEDGER_TAIL = [
  "ProjectionThreadsMiniSkills",
  "ProjectionThreadsMiniSkillsReconciliation",
  "ProjectionThreadsActiveOrderKey",
  "ComputeJobs",
  "ThreadHandoffs",
  "ProjectionThreadPullRequests",
  "ReconcileProjectionThreadFeatures",
  "ProjectionThreadTitleStateReconciliation",
  "RepairProjectionThreadMessageContext",
  "PullRequestFilesViewed",
  "ScheduledMessages",
  "ProjectionThreadsAutoSettleDisabledAt",
  "ProjectionProjectLinkKey",
  "OrchestrationV2",
  "RemoveRedundantProjectionIndexes",
  "ScheduledMessagesOrchestrationV2",
  ...UPSTREAM_MIGRATIONS.filter(([id]) => id >= 57 && id <= 98).map(([, name]) => name),
];

const forkLedger = (): LedgerRow[] => [
  ...UPSTREAM_MIGRATIONS.filter(([id]) => id <= 47).map(([id, name]) => ({
    id,
    name,
    createdAt: `created-${id}`,
  })),
  ...FORK_LEDGER_TAIL.map((name, index) => ({
    id: 48 + index,
    name,
    createdAt: `created-${48 + index}`,
  })),
];

const column = (notNull = false, hasDefault = false): ColumnFact => ({ notNull, hasDefault });

const facts = (overrides: Record<string, Record<string, ColumnFact>> = {}): SchemaFacts => {
  const tables: Record<string, Record<string, ColumnFact>> = {
    projection_threads: {
      branch_pull_request_json: column(),
      title_state_json: column(),
      mini_skills_json: column(),
    },
    projection_thread_messages: { context_json: column() },
    projection_projects: { link_key: column() },
    scheduled_tasks: { fallback_model_selections_json: column(true, true) },
    compute_jobs: {},
    automation_journal: {},
    ...overrides,
  };
  return {
    tables: Object.keys(tables),
    columns: new Map(
      Object.entries(tables).map(([table, cols]) => [table, new Map(Object.entries(cols))]),
    ),
  };
};

describe("planRealign", () => {
  // Read as text: importing the server's migrations would pull its sources into this package's typecheck.
  it("embeds a prefix of upstream's manifest", () => {
    const source = NodeFS.readFileSync(
      new URL("../apps/server/src/persistence/Migrations.ts", import.meta.url),
      "utf8",
    );
    const manifest = [...source.matchAll(/^\s+\[(\d+), "(\w+)", Migration\d+\],$/gm)].map(
      ([, id, name]) => [Number(id), name],
    );
    // Later upstream migrations only extend what the runner applies after the rewrite.
    expect(manifest.length).toBeGreaterThanOrEqual(UPSTREAM_MIGRATIONS.length);
    expect(UPSTREAM_MIGRATIONS).toEqual(manifest.slice(0, UPSTREAM_MIGRATIONS.length));
  });

  it("maps the fork ledger onto upstream's ids and leaves the rest to the runner", () => {
    const plan = planRealign(forkLedger(), facts());

    expect(plan.problems).toEqual([]);
    expect(FORK_LEDGER_TAIL.length + 47).toBe(105);
    expect(plan.ledger.map((row) => [row.id, row.name])).toEqual(
      UPSTREAM_MIGRATIONS.filter(([id]) => id <= 98),
    );
    expect(plan.pending.map(([id]) => id)).toEqual([99, 100, 101, 102, 103, 104, 105]);

    const target = (forkId: number) =>
      plan.mapping.find((row) => row.fork.id === forkId)?.upstream ?? null;
    expect(target(48)).toBeNull();
    expect(target(49)).toEqual({ id: 48, name: "ProjectionThreadBranchPullRequest" });
    expect(target(55)).toEqual({ id: 52, name: "ProjectionThreadTitleState" });
    expect(target(56)).toEqual({ id: 51, name: "ProjectionThreadMessageContext" });
    expect(target(61)).toEqual({ id: 55, name: "OrchestrationV2" });
    expect(target(105)).toEqual({ id: 98, name: "ActiveShellIndexIndexes" });
    // A realigned row keeps when the fork applied it.
    expect(plan.ledger.find((row) => row.id === 55)?.createdAt).toBe("created-61");

    expect(plan.dropColumns).toEqual([]);
    expect(plan.keptColumns.map(([table, col]) => `${table}.${col}`)).toEqual([
      "projection_projects.link_key",
      "projection_threads.mini_skills_json",
      "scheduled_tasks.fallback_model_selections_json",
    ]);
    expect(plan.keptTables).toEqual(["compute_jobs", "automation_journal"]);
    expect(plan.alreadyAligned).toBe(false);
  });

  it("is a no-op on a ledger it already realigned", () => {
    const first = planRealign(forkLedger(), facts());
    const second = planRealign(first.ledger, facts());
    expect(second.alreadyAligned).toBe(true);
    expect(second.ledger).toEqual(first.ledger);
  });

  it("refuses an alias whose column is missing, since the runner would never add it", () => {
    const plan = planRealign(forkLedger(), facts({ projection_thread_messages: {} }));
    expect(plan.problems.join("\n")).toContain(
      "projection_thread_messages.context_json is missing",
    );
    expect(plan.problems.join("\n")).toContain("would re-run");
    expect(plan.ledger.at(-1)?.id).toBe(50);
  });

  it("stops the ledger at a trailing gap so the runner applies the rest", () => {
    const rows = forkLedger().filter((row) => row.id <= 100);
    const plan = planRealign(rows, facts());
    expect(plan.problems).toEqual([]);
    expect(plan.ledger.at(-1)?.id).toBe(93);
    expect(plan.pending[0]).toEqual([94, "TurnItemMessageOrdinalIndex"]);
  });

  it("refuses names it does not know", () => {
    const plan = planRealign(
      [...forkLedger(), { id: 106, name: "SomethingNew", createdAt: "" }],
      facts(),
    );
    expect(plan.problems).toEqual(["Ledger row 106:SomethingNew is unknown to this tool."]);
  });

  it("drops a fork column upstream inserts would violate", () => {
    const plan = planRealign(
      forkLedger(),
      facts({ projection_projects: { link_key: column(true, false) } }),
    );
    expect(plan.dropColumns).toEqual([["projection_projects", "link_key"]]);
  });
});
