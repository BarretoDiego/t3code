#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Standalone one-time repair; it must run with a bare Node (>= 24.2) on hosts without a checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

/**
 * One-time repair for a statev2.sqlite written by the BarretoDiego fork, whose
 * migration ledger renumbered upstream migrations and interleaved fork-only ones.
 * It rewrites the ledger to upstream's ids and names, so upstream's unchanged
 * runMigrations() accepts the database and applies only what it lacks.
 */

/** Upstream's manifest (apps/server/src/persistence/Migrations.ts); the test keeps the two equal. */
export const UPSTREAM_MIGRATIONS: ReadonlyArray<readonly [id: number, name: string]> = [
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
  [34, "ProjectionThreadsSnoozed"],
  [35, "ProjectionThreadTitleRegeneration"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
  [57, "ScheduledTaskWebhooks"],
  [58, "WebhookRelayDeliveries"],
  [59, "McpAppModelContext"],
  [60, "ThreadSnapshotWindowIndexes"],
  [61, "PullRequestReviewGuides"],
  [62, "ThreadFailureLookupIndex"],
  [63, "DropUnusedV1Projections"],
  [64, "CanonicalizeThreadPullRequestLinks"],
  [65, "CodexUsageNativeTurnIndex"],
  [66, "RepairClientSettlementTimestamps"],
  [67, "WebhookDedupe"],
  [68, "ShellStopRequestIndex"],
  [69, "ThreadMessageSearch"],
  [70, "PeerLinks"],
  [71, "PeerLinkFence"],
  [72, "WaitingLinkRequestIndex"],
  [73, "ActiveTurnItemIndexes"],
  [74, "ExcludeAttachmentPlaceholdersFromSearch"],
  [75, "SubagentDeliveryState"],
  [76, "ProjectionProjectsPinArchive"],
  [77, "RepairBooleanSettledOverride"],
  [78, "DropOrchestrationEventCorrelationIndex"],
  [79, "DelegatedRecoveryIndexes"],
  [80, "ScheduledTaskThreadMode"],
  [81, "ProjectionMessageSearchText"],
  [82, "TurnItemConversationIndex"],
  [83, "CommandReadIndexes"],
  [84, "LastExecutedRunIndex"],
  [85, "TurnItemCounts"],
  [86, "QueuedTurnInputIndex"],
  [87, "ProjectionProjectsCustomTitle"],
  [88, "TurnItemTypeStatusIndex"],
  [89, "ShellThreadReadIndexes"],
  [90, "AuthConnectDevices"],
  [91, "AuthConnectDeniedRequests"],
  [92, "QueuedTurnInputIndexJsonValid"],
  [93, "ProviderTurnAttemptIndex"],
  [94, "TurnItemMessageOrdinalIndex"],
  [95, "TurnItemInlineWorkOutput"],
  [96, "RepairStaleTitleRegeneration"],
  [97, "IssueTrackerBindings"],
  [98, "ActiveShellIndexIndexes"],
  [99, "BackgroundRecoveryIndexes"],
  [100, "TurnStartReadIndexes"],
  [101, "DelegatedTaskReadIndexes"],
  [102, "ThreadItemCounts"],
  [103, "IssueTrackerAdditionalScopes"],
  [104, "ProjectionProjectsTrackedFolders"],
  [105, "TaskFolders"],
];

/**
 * Fork ledger names that differ from upstream's. A string names the upstream
 * migration whose schema change the fork applied under that name; null marks a
 * fork-only migration. Names equal to an upstream name map to it directly.
 */
export const FORK_LEDGER_ALIASES: ReadonlyMap<string, string | null> = new Map([
  // Early fork builds recorded these at 48 and 54; later fork migrations re-added their columns.
  ["ProjectionThreadsMiniSkills", null],
  ["ProjectionThreadsMiniSkillsReconciliation", "ProjectionThreadBranchPullRequest"],
  ["ReconcileProjectionThreadFeatures", null],
  ["RepairProjectionThreadMessageContext", "ProjectionThreadMessageContext"],
  ["ProjectionThreadTitleStateReconciliation", "ProjectionThreadTitleState"],
  ["ComputeJobs", null],
  ["ThreadHandoffs", null],
  ["ScheduledMessages", null],
  ["ProjectionProjectLinkKey", null],
  ["ScheduledMessagesOrchestrationV2", null],
]);

/** Each aliased upstream migration counts as applied only when its column is really there. */
const ALIAS_EVIDENCE: ReadonlyMap<string, readonly [table: string, column: string]> = new Map([
  ["ProjectionThreadBranchPullRequest", ["projection_threads", "branch_pull_request_json"]],
  ["ProjectionThreadMessageContext", ["projection_thread_messages", "context_json"]],
  ["ProjectionThreadTitleState", ["projection_threads", "title_state_json"]],
]);

/**
 * Fork columns on tables upstream writes. Upstream inserts name their columns,
 * so a nullable or defaulted extra column is inert; one that is NOT NULL
 * without a default would fail those inserts and must go.
 */
export const FORK_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["projection_projects", "link_key"],
  ["projection_threads", "mini_skills_json"],
  ["scheduled_tasks", "fallback_model_selections_json"],
];

/** Fork-only tables upstream never reads. They are left in place. */
export const FORK_TABLE_PREFIXES = [
  "automation_",
  "legacy_v1_reconciliation_",
  "compute_",
  "thread_handoff",
  "scheduled_messages",
  "projection_thread_activities",
  "t3_automation_migrations",
] as const;

export interface LedgerRow {
  readonly id: number;
  readonly name: string;
  readonly createdAt: string;
}

export interface ColumnFact {
  readonly notNull: boolean;
  readonly hasDefault: boolean;
}

export interface SchemaFacts {
  readonly tables: ReadonlyArray<string>;
  readonly columns: ReadonlyMap<string, ReadonlyMap<string, ColumnFact>>;
}

export interface MappingRow {
  readonly fork: LedgerRow;
  readonly upstream: { readonly id: number; readonly name: string } | null;
}

export interface RealignPlan {
  readonly mapping: ReadonlyArray<MappingRow>;
  /** The ledger upstream's runner will read. */
  readonly ledger: ReadonlyArray<LedgerRow>;
  /** Upstream migrations the runner will apply after the rewrite. */
  readonly pending: ReadonlyArray<readonly [number, string]>;
  readonly dropColumns: ReadonlyArray<readonly [table: string, column: string]>;
  readonly keptColumns: ReadonlyArray<readonly [table: string, column: string]>;
  readonly keptTables: ReadonlyArray<string>;
  readonly alreadyAligned: boolean;
  /** Reasons the plan must not be applied. */
  readonly problems: ReadonlyArray<string>;
}

const upstreamByName = new Map(UPSTREAM_MIGRATIONS.map(([id, name]) => [name, id] as const));

export function planRealign(rows: ReadonlyArray<LedgerRow>, facts: SchemaFacts): RealignPlan {
  const problems: string[] = [];
  const hasColumn = (table: string, column: string) =>
    facts.columns.get(table)?.has(column) ?? false;

  const mapping = [...rows]
    .sort((a, b) => a.id - b.id)
    .map((fork): MappingRow => {
      const alias = FORK_LEDGER_ALIASES.get(fork.name);
      const upstreamName = alias === undefined ? fork.name : alias;
      if (upstreamName === null) return { fork, upstream: null };
      const id = upstreamByName.get(upstreamName);
      if (id === undefined) {
        problems.push(`Ledger row ${fork.id}:${fork.name} is unknown to this tool.`);
        return { fork, upstream: null };
      }
      const evidence = ALIAS_EVIDENCE.get(upstreamName);
      if (upstreamName !== fork.name && evidence && !hasColumn(...evidence)) {
        problems.push(
          `Ledger row ${fork.id}:${fork.name} claims ${upstreamName}, but ${evidence.join(".")} is missing.`,
        );
        return { fork, upstream: null };
      }
      return { fork, upstream: { id, name: upstreamName } };
    });

  const createdAt = new Map<number, string>();
  for (const { fork, upstream } of mapping) {
    if (upstream && !createdAt.has(upstream.id)) createdAt.set(upstream.id, fork.createdAt);
  }

  // The runner applies only ids above the highest recorded, so the ledger must be a gap-free prefix.
  const firstGap = UPSTREAM_MIGRATIONS.find(([id]) => !createdAt.has(id));
  const prefixEnd = firstGap === undefined ? Infinity : firstGap[0];
  const ledger = UPSTREAM_MIGRATIONS.filter(([id]) => id < prefixEnd).map(([id, name]) => ({
    id,
    name,
    createdAt: createdAt.get(id) ?? "",
  }));
  const pending = UPSTREAM_MIGRATIONS.filter(([id]) => id >= prefixEnd);
  const rerun = pending.filter(([id]) => createdAt.has(id));
  if (rerun.length > 0) {
    problems.push(
      `Upstream ${firstGap?.join("_")} is missing while later ones were applied; the runner would re-run ${rerun
        .map(([id, name]) => `${id}_${name}`)
        .join(", ")}, which this tool has not proven safe.`,
    );
  }

  const dropColumns: Array<readonly [string, string]> = [];
  const keptColumns: Array<readonly [string, string]> = [];
  for (const [table, column] of FORK_COLUMNS) {
    const fact = facts.columns.get(table)?.get(column);
    if (fact === undefined) continue;
    (fact.notNull && !fact.hasDefault ? dropColumns : keptColumns).push([table, column]);
  }

  const keptTables = facts.tables.filter((table) =>
    FORK_TABLE_PREFIXES.some((prefix) => table.startsWith(prefix)),
  );

  const alreadyAligned =
    dropColumns.length === 0 &&
    rows.length === ledger.length &&
    ledger.every((row) => rows.some((r) => r.id === row.id && r.name === row.name));

  return {
    mapping,
    ledger,
    pending,
    dropColumns,
    keptColumns,
    keptTables,
    alreadyAligned,
    problems,
  };
}

export function readFacts(db: NodeSqlite.DatabaseSync): {
  readonly rows: ReadonlyArray<LedgerRow>;
  readonly facts: SchemaFacts;
} {
  const ledgerTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'")
    .get();
  if (ledgerTable === undefined)
    throw new Error("No effect_sql_migrations table: not a T3 database.");
  const rows = db
    .prepare(
      "SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id",
    )
    .all()
    .map((row) => ({
      id: Number(row.migration_id),
      name: String(row.name),
      createdAt: String(row.created_at),
    }));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name));
  const columns = new Map<string, Map<string, ColumnFact>>();
  for (const table of tables) {
    const info = db
      .prepare('SELECT name, "notnull" AS nn, dflt_value FROM pragma_table_info(?)')
      .all(table);
    columns.set(
      table,
      new Map(
        info.map((col) => [
          String(col.name),
          { notNull: Number(col.nn) === 1, hasDefault: col.dflt_value !== null },
        ]),
      ),
    );
  }
  return { rows, facts: { tables, columns } };
}

export function formatPlan(plan: RealignPlan): string {
  const lines: string[] = ["Ledger mapping (fork -> upstream):"];
  for (const { fork, upstream } of plan.mapping) {
    const target = upstream ? `${upstream.id}_${upstream.name}` : "(dropped: fork-only)";
    const same = upstream && upstream.id === fork.id && upstream.name === fork.name;
    lines.push(`  ${String(fork.id).padStart(3)}_${fork.name} -> ${same ? "unchanged" : target}`);
  }
  const last = plan.ledger.at(-1);
  lines.push(`Rewritten ledger: ${plan.ledger.length} rows, ids 1..${last?.id ?? 0}.`);
  lines.push(
    plan.pending.length === 0
      ? "Upstream's runner will apply nothing."
      : `Upstream's runner will then apply: ${plan.pending.map(([id, name]) => `${id}_${name}`).join(", ")}`,
  );
  for (const [table, column] of plan.dropColumns) lines.push(`Drop column ${table}.${column}`);
  for (const [table, column] of plan.keptColumns) {
    lines.push(`Keep fork column ${table}.${column} (nullable or defaulted)`);
  }
  if (plan.keptTables.length > 0) {
    lines.push(
      `Keep ${plan.keptTables.length} fork-only tables upstream never reads: ${plan.keptTables.join(", ")}`,
    );
  }
  if (plan.alreadyAligned) lines.push("The ledger already matches upstream; nothing to do.");
  for (const problem of plan.problems) lines.push(`PROBLEM: ${problem}`);
  return lines.join("\n");
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** A server holds an exclusive transaction on server-owner.sqlite; a read is refused only then. */
function homeOwnershipLocked(dbPath: string): boolean {
  const lockPath = NodePath.join(NodePath.dirname(dbPath), "server-owner.sqlite");
  if (!NodeFS.existsSync(lockPath)) return false;
  try {
    const lock = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
    try {
      lock.exec("PRAGMA busy_timeout = 0");
      lock.prepare("SELECT count(*) FROM sqlite_master").get();
      return false;
    } finally {
      lock.close();
    }
  } catch (cause) {
    return cause instanceof Error && "errcode" in cause && cause.errcode === 5;
  }
}

function applyPlan(db: NodeSqlite.DatabaseSync, plan: RealignPlan): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM effect_sql_migrations");
    const insert = db.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, created_at, name) VALUES (?, ?, ?)",
    );
    for (const row of plan.ledger) insert.run(row.id, row.createdAt, row.name);
    for (const [table, column] of plan.dropColumns) {
      db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function main(argv: ReadonlyArray<string>): number {
  const apply = argv.includes("--apply");
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  if (positional.length !== 1) {
    console.error("usage: node scripts/fork-ledger-realign.ts <path/to/statev2.sqlite> [--apply]");
    return 2;
  }
  const dbPath = NodePath.resolve(positional[0] ?? "");
  if (!NodeFS.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}.`);
    return 2;
  }

  if (apply && homeOwnershipLocked(dbPath)) {
    console.error("A T3 server owns this T3 home. Quit T3 Code (and any t3 server) first.");
    return 1;
  }
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: !apply });
  try {
    if (apply) {
      db.exec("PRAGMA busy_timeout = 0");
      // A running T3 server holds the database; refuse rather than race it.
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
      } catch {
        console.error("The database is in use. Quit T3 Code (and any t3 server) first.");
        return 1;
      }
    }
    const { rows, facts } = readFacts(db);
    const plan = planRealign(rows, facts);
    console.log(formatPlan(plan));
    if (plan.problems.length > 0) {
      console.error("Refusing to continue; nothing was changed.");
      return 1;
    }
    if (plan.alreadyAligned) return 0;
    if (!apply) {
      console.log("\nDry run. Re-run with --apply (app quit) to back up and rewrite.");
      return 0;
    }
    const backupPath = `${dbPath}.before-fork-realign-${timestamp()}`;
    console.log(`\nBacking up to ${backupPath} ...`);
    db.prepare("VACUUM INTO ?").run(backupPath);
    applyPlan(db, plan);
    console.log(
      "Ledger rewritten. Start the upstream-based build; it applies the pending migrations.",
    );
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
