import type {
  EnvironmentId,
  ProjectId,
  SidebarSectionOrderMode,
  SidebarThreadGroupingAxis,
} from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../providerInstances";

/**
 * Grouping for the sidebar inbox.
 *
 * The inbox is a flat thread list by default. These helpers slice it into up
 * to two nested levels of collapsible sections along independent axes
 * (environment / project / provider) without touching the ordering the caller
 * already applied: sections are emitted in first-appearance order, and threads
 * keep their incoming order inside every section. That keeps sort order and
 * grouping orthogonal — changing one never silently reshuffles the other.
 */

/** Minimum thread shape the grouping needs. Keeps this module testable without the full shell type. */
export interface GroupableThread {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: { readonly instanceId: string };
  readonly session?: { readonly providerInstanceId?: string | undefined } | null | undefined;
}

export interface SidebarThreadGroupContext {
  /** Environment display label, or null when the environment is unnamed/unknown. */
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  /** Logical project display name for a thread's `environmentId:projectId` pair. */
  readonly resolveProjectLabel: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => string | null;
  /** Provider instance entries per environment, used to resolve a thread's driver kind. */
  readonly providerEntriesByEnvironment: ReadonlyMap<
    string,
    ReadonlyMap<string, ProviderInstanceEntry>
  >;
  /**
   * Classifies a thread for the section rollup, or null when it needs no
   * attention. Injected so the grouping stays a pure function of its inputs
   * and reuses whatever status rules the rows themselves follow.
   */
  readonly classifyAttention?: (thread: GroupableThread) => SidebarAttentionClass | null;
}

/** What a thread is waiting on, in the order a collapsed header lists them. */
export type SidebarAttentionClass = "approval" | "input" | "failed" | "unread" | "working";

export const SIDEBAR_ATTENTION_CLASSES: ReadonlyArray<SidebarAttentionClass> = [
  "approval",
  "input",
  "failed",
  "unread",
  "working",
];

export type SidebarAttentionCounts = Readonly<Record<SidebarAttentionClass, number>>;

const EMPTY_ATTENTION: SidebarAttentionCounts = {
  approval: 0,
  input: 0,
  failed: 0,
  unread: 0,
  working: 0,
};

function countAttention(
  threads: ReadonlyArray<GroupableThread>,
  classify: SidebarThreadGroupContext["classifyAttention"],
): SidebarAttentionCounts {
  if (classify === undefined) {
    return EMPTY_ATTENTION;
  }
  const counts: Record<SidebarAttentionClass, number> = { ...EMPTY_ATTENTION };
  for (const thread of threads) {
    const attention = classify(thread);
    if (attention !== null) {
      counts[attention] += 1;
    }
  }
  return counts;
}

export interface SidebarThreadProviderIdentity {
  /** Stable across environments and instance renames — what the filter persists. */
  readonly driverKind: string;
  readonly label: string;
}

/**
 * What a section is *about*, when that is a single addressable thing.
 *
 * The header needs this to act on the section — start a thread in this
 * project, add a project to this environment. Reading it off the first thread
 * would work only for sections that have threads, and sections now exist
 * precisely when they don't (an empty project still gets a row).
 */
export interface SidebarThreadGroupTarget {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
}

export interface SidebarThreadGroup<TThread extends GroupableThread> {
  /** Stable key for collapse persistence and React keys. Unique within the tree. */
  readonly key: string;
  readonly label: string;
  readonly axis: Exclude<SidebarThreadGroupingAxis, "none">;
  /** The environment/project this section addresses, when it addresses one. */
  readonly target: SidebarThreadGroupTarget;
  /** Threads directly in this section — empty when `children` carries them instead. */
  readonly threads: ReadonlyArray<TThread>;
  /**
   * Settled threads belonging to this section, in the order the caller passed
   * them. Kept apart from `threads` so a section can show its history without
   * history competing with live work for the same space.
   */
  readonly settledThreads: ReadonlyArray<TThread>;
  /** Nested sections when a secondary axis is active. */
  readonly children: ReadonlyArray<SidebarThreadGroup<TThread>>;
  /** Total threads in this section, including every descendant. */
  readonly threadCount: number;
  /** Settled threads in this section, including every descendant. */
  readonly settledCount: number;
  /** Attention rollup over every thread in this section, including descendants. */
  readonly attention: SidebarAttentionCounts;
}

/**
 * A section that must exist even with nothing in it.
 *
 * The sidebar seeds one per known project so every project keeps a row — and
 * therefore its New thread and settings buttons — whether or not it currently
 * has a single thread. Without this, the only way to reach a quiet project
 * would be to already have work in it.
 */
export interface SidebarThreadGroupSeed {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const UNKNOWN_PROVIDER_DRIVER = "unknown";

/**
 * Resolves the provider a thread is actually running on.
 *
 * Mirrors `SidebarThreadRow`: a live session's instance wins over the thread's
 * configured model selection, because that is the provider the user sees in
 * the row badge. Falls back to a synthetic "unknown" identity so threads on a
 * provider that was deleted (or whose environment config has not streamed in
 * yet) still land in a section instead of vanishing from the list.
 */
export function resolveThreadProviderIdentity(
  thread: GroupableThread,
  providerEntriesByEnvironment: SidebarThreadGroupContext["providerEntriesByEnvironment"],
): SidebarThreadProviderIdentity {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entry = providerEntriesByEnvironment.get(thread.environmentId)?.get(instanceId) ?? null;
  if (entry === null) {
    return { driverKind: UNKNOWN_PROVIDER_DRIVER, label: "Unknown provider" };
  }
  return { driverKind: entry.driverKind, label: providerDriverLabel(entry) };
}

/**
 * Driver-level label, not the instance's `displayName`.
 *
 * The filter and the provider sections are keyed by driver kind, so two custom
 * instances of the same driver ("Claude (work)" and "Claude (personal)") must
 * collapse into one section titled after the driver rather than whichever
 * instance happened to be seen first.
 */
function providerDriverLabel(entry: ProviderInstanceEntry): string {
  if (entry.isDefault) {
    return entry.displayName;
  }
  const driverKind = entry.driverKind as string;
  return driverKind.charAt(0).toUpperCase() + driverKind.slice(1);
}

/**
 * Every provider present in the current thread set, in first-appearance order.
 *
 * Derived from the threads rather than from the provider config so the filter
 * menu only ever offers providers that would actually narrow something.
 */
export function deriveSidebarProviderOptions(
  threads: ReadonlyArray<GroupableThread>,
  providerEntriesByEnvironment: SidebarThreadGroupContext["providerEntriesByEnvironment"],
): ReadonlyArray<SidebarThreadProviderIdentity> {
  const byDriverKind = new Map<string, SidebarThreadProviderIdentity>();
  for (const thread of threads) {
    const identity = resolveThreadProviderIdentity(thread, providerEntriesByEnvironment);
    if (!byDriverKind.has(identity.driverKind)) {
      byDriverKind.set(identity.driverKind, identity);
    }
  }
  return [...byDriverKind.values()];
}

interface BucketIdentity {
  readonly key: string;
  readonly label: string;
  readonly target: SidebarThreadGroupTarget;
}

const NO_TARGET: SidebarThreadGroupTarget = { environmentId: null, projectId: null };

function environmentBucket(
  environmentId: EnvironmentId,
  context: SidebarThreadGroupContext,
): BucketIdentity {
  return {
    key: `environment:${environmentId}`,
    label: context.resolveEnvironmentLabel(environmentId) ?? "This computer",
    target: { environmentId, projectId: null },
  };
}

function projectBucket(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  context: SidebarThreadGroupContext,
): BucketIdentity {
  return {
    key: `project:${environmentId}:${projectId}`,
    label: context.resolveProjectLabel(environmentId, projectId) ?? "Unknown project",
    target: { environmentId, projectId },
  };
}

function bucketForAxis(
  thread: GroupableThread,
  axis: Exclude<SidebarThreadGroupingAxis, "none">,
  context: SidebarThreadGroupContext,
): BucketIdentity {
  switch (axis) {
    case "environment":
      return environmentBucket(thread.environmentId, context);
    case "project":
      return projectBucket(thread.environmentId, thread.projectId, context);
    case "provider": {
      const identity = resolveThreadProviderIdentity(thread, context.providerEntriesByEnvironment);
      return { key: `provider:${identity.driverKind}`, label: identity.label, target: NO_TARGET };
    }
  }
}

/**
 * The bucket a seed belongs to on a given axis, or null when the axis cannot
 * be derived from a project alone. A project has no provider until a thread
 * runs in it, so seeding a provider section would be inventing data.
 */
function bucketForSeed(
  seed: SidebarThreadGroupSeed,
  axis: Exclude<SidebarThreadGroupingAxis, "none">,
  context: SidebarThreadGroupContext,
): BucketIdentity | null {
  switch (axis) {
    case "environment":
      return environmentBucket(seed.environmentId, context);
    case "project":
      return projectBucket(seed.environmentId, seed.projectId, context);
    case "provider":
      return null;
  }
}

/** Seeds that belong under a parent section, for the nested level. */
function seedsUnder(
  seeds: ReadonlyArray<SidebarThreadGroupSeed>,
  parent: BucketIdentity,
): ReadonlyArray<SidebarThreadGroupSeed> {
  if (parent.target.environmentId === null) {
    return [];
  }
  return seeds.filter(
    (seed) =>
      seed.environmentId === parent.target.environmentId &&
      (parent.target.projectId === null || seed.projectId === parent.target.projectId),
  );
}

interface Bucket<TThread extends GroupableThread> {
  readonly identity: BucketIdentity;
  readonly threads: TThread[];
  readonly settled: TThread[];
}

/**
 * Buckets threads on one axis.
 *
 * Emission order is deliberate and layered: sections with live work first (in
 * first-appearance order), then sections that only hold history, then the
 * seeded-but-empty ones. A quiet project keeps its row without pushing the
 * work you are actually doing down the list.
 */
function partitionByAxis<TThread extends GroupableThread>(input: {
  readonly threads: ReadonlyArray<TThread>;
  readonly settledThreads: ReadonlyArray<TThread>;
  readonly seeds: ReadonlyArray<SidebarThreadGroupSeed>;
  readonly axis: Exclude<SidebarThreadGroupingAxis, "none">;
  readonly context: SidebarThreadGroupContext;
}): Array<Bucket<TThread>> {
  const { axis, context } = input;
  const buckets = new Map<string, Bucket<TThread>>();
  const ensure = (identity: BucketIdentity): Bucket<TThread> => {
    const existing = buckets.get(identity.key);
    if (existing) {
      return existing;
    }
    const created: Bucket<TThread> = { identity, threads: [], settled: [] };
    buckets.set(identity.key, created);
    return created;
  };

  for (const thread of input.threads) {
    ensure(bucketForAxis(thread, axis, context)).threads.push(thread);
  }
  const activeKeys = new Set(buckets.keys());
  for (const thread of input.settledThreads) {
    ensure(bucketForAxis(thread, axis, context)).settled.push(thread);
  }
  const seenKeys = new Set(buckets.keys());
  for (const seed of input.seeds) {
    const identity = bucketForSeed(seed, axis, context);
    if (identity !== null) {
      ensure(identity);
    }
  }

  const ordered = [...buckets.values()];
  const rank = (bucket: Bucket<TThread>): number =>
    activeKeys.has(bucket.identity.key) ? 0 : seenKeys.has(bucket.identity.key) ? 1 : 2;
  // Stable sort: within a rank the insertion order (first appearance) holds.
  return ordered.sort((a, b) => rank(a) - rank(b));
}

/**
 * Splits threads into up to two nested levels of sections.
 *
 * Returns an empty array when no grouping applies, which the sidebar reads as
 * "render the flat list" — the caller never has to special-case a single
 * synthetic wrapper section.
 *
 * A secondary axis equal to the primary one is ignored rather than producing a
 * level of single-child sections that only add indentation.
 */
export function buildSidebarThreadGroups<TThread extends GroupableThread>(input: {
  readonly threads: ReadonlyArray<TThread>;
  /**
   * History for the same sections. Grouped on the same axes so a section owns
   * its own archive instead of every section's history piling into one shelf
   * at the bottom of the sidebar.
   */
  readonly settledThreads?: ReadonlyArray<TThread>;
  /** Sections that must exist even with no threads at all. */
  readonly seeds?: ReadonlyArray<SidebarThreadGroupSeed>;
  readonly primaryAxis: SidebarThreadGroupingAxis;
  readonly secondaryAxis: SidebarThreadGroupingAxis;
  readonly context: SidebarThreadGroupContext;
}): ReadonlyArray<SidebarThreadGroup<TThread>> {
  const { primaryAxis, secondaryAxis, context, threads } = input;
  const settledThreads = input.settledThreads ?? [];
  const seeds = input.seeds ?? [];
  if (primaryAxis === "none") {
    return [];
  }
  if (threads.length === 0 && settledThreads.length === 0 && seeds.length === 0) {
    return [];
  }

  const nestedAxis =
    secondaryAxis === "none" || secondaryAxis === primaryAxis ? null : secondaryAxis;

  return partitionByAxis({
    threads,
    settledThreads,
    seeds,
    axis: primaryAxis,
    context,
  }).map((bucket) => {
    const { identity } = bucket;
    const attention = countAttention(bucket.threads, context.classifyAttention);
    if (nestedAxis === null) {
      return {
        key: identity.key,
        label: identity.label,
        axis: primaryAxis,
        target: identity.target,
        threads: bucket.threads,
        settledThreads: bucket.settled,
        children: [],
        threadCount: bucket.threads.length,
        settledCount: bucket.settled.length,
        attention,
      } satisfies SidebarThreadGroup<TThread>;
    }

    const children = partitionByAxis({
      threads: bucket.threads,
      settledThreads: bucket.settled,
      seeds: seedsUnder(seeds, identity),
      axis: nestedAxis,
      context,
    }).map(
      (child): SidebarThreadGroup<TThread> => ({
        // Prefixed with the parent key so the same child bucket under two
        // parents gets two independent collapse states.
        key: `${identity.key}/${child.identity.key}`,
        label: child.identity.label,
        axis: nestedAxis,
        target: child.identity.target,
        threads: child.threads,
        settledThreads: child.settled,
        children: [],
        threadCount: child.threads.length,
        settledCount: child.settled.length,
        attention: countAttention(child.threads, context.classifyAttention),
      }),
    );

    return {
      key: identity.key,
      label: identity.label,
      axis: primaryAxis,
      target: identity.target,
      threads: [],
      // Nesting moves every thread down a level, history included: a parent
      // that owned its settled rows *and* had children would render the same
      // history twice.
      settledThreads: [],
      children,
      threadCount: bucket.threads.length,
      settledCount: bucket.settled.length,
      attention,
    } satisfies SidebarThreadGroup<TThread>;
  });
}

/**
 * How sections are arranged, layered on top of the order the grouping
 * produced. Grouping decides which sections exist; this decides where they go.
 */
export interface SidebarSectionOrder {
  readonly mode: SidebarSectionOrderMode;
  /** Section keys in user order. Read only when `mode` is `manual`. */
  readonly manualKeys: ReadonlyArray<string>;
}

// Numeric so "env 2" precedes "env 10", base sensitivity so case and accents
// never decide a tie the user did not ask for.
const SECTION_LABEL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * Rearranges every level of the section tree.
 *
 * Applied after building rather than inside the bucketing so it can key off
 * the final section keys — nested keys are parent-prefixed, and those prefixed
 * keys are what a manual order and the collapse state both refer to.
 *
 * Only the order of sections changes: their threads, counts and nesting are
 * passed through untouched, so ordering stays orthogonal to grouping the same
 * way sorting already is.
 */
export function orderSidebarThreadGroups<TThread extends GroupableThread>(
  groups: ReadonlyArray<SidebarThreadGroup<TThread>>,
  order: SidebarSectionOrder,
): ReadonlyArray<SidebarThreadGroup<TThread>> {
  // The build order *is* the activity order, so this mode is a pass-through —
  // returning the same array keeps referential equality for memoized callers.
  if (order.mode === "activity") {
    return groups;
  }
  const rank = new Map(order.manualKeys.map((key, index) => [key, index] as const));
  const orderLevel = (
    level: ReadonlyArray<SidebarThreadGroup<TThread>>,
  ): ReadonlyArray<SidebarThreadGroup<TThread>> => {
    if (order.mode === "alphabetical") {
      return [...level].sort((a, b) => SECTION_LABEL_COLLATOR.compare(a.label, b.label));
    }
    // A section the user never placed — a project added since the last
    // arrangement — keeps its incoming order and lands after everything that
    // was placed, rather than silently displacing it.
    const placed = level
      .filter((group) => rank.has(group.key))
      .sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
    if (placed.length === level.length) {
      return placed;
    }
    return [...placed, ...level.filter((group) => !rank.has(group.key))];
  };
  const walk = (
    level: ReadonlyArray<SidebarThreadGroup<TThread>>,
  ): ReadonlyArray<SidebarThreadGroup<TThread>> =>
    orderLevel(level).map((group) =>
      group.children.length === 0 ? group : { ...group, children: walk(group.children) },
    );
  return walk(groups);
}

/**
 * Every section key in the tree, parents before their children.
 *
 * Used to seed a manual arrangement from what is currently on screen, so
 * switching to manual freezes the layout the user is looking at instead of
 * leaving unplaced levels free to reshuffle as work arrives.
 */
export function collectSidebarSectionKeys<TThread extends GroupableThread>(
  groups: ReadonlyArray<SidebarThreadGroup<TThread>>,
): ReadonlyArray<string> {
  return groups.flatMap((group) => [group.key, ...collectSidebarSectionKeys(group.children)]);
}

/**
 * The manual key list after moving one section within its own level.
 *
 * `siblingKeys` is the level exactly as rendered, so a drop or a Move up
 * rewrites the whole level in one go and the result no longer depends on
 * whatever the level's activity order happened to be.
 */
export function planSidebarSectionOrder(input: {
  readonly siblingKeys: ReadonlyArray<string>;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly manualKeys: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const { fromIndex, manualKeys, siblingKeys, toIndex } = input;
  const inRange = (index: number) => index >= 0 && index < siblingKeys.length;
  if (!inRange(fromIndex) || !inRange(toIndex) || fromIndex === toIndex) {
    return manualKeys;
  }
  const moved = [...siblingKeys];
  const [key] = moved.splice(fromIndex, 1);
  moved.splice(toIndex, 0, key!);
  // Levels never share keys and ranks are only ever compared within a level,
  // so where this level's block sits in the flat list means nothing: dropping
  // the old entries and appending the new ones is the whole merge.
  const levelKeys = new Set(siblingKeys);
  return [...manualKeys.filter((existing) => !levelKeys.has(existing)), ...moved];
}

/**
 * Flattens the group tree into the rows the sidebar renders, honoring collapse
 * state.
 *
 * Collapsing a parent hides its subsections entirely — including their own
 * headers — so a collapsed section is always exactly one row tall regardless
 * of how deep it nests.
 */
export type SidebarThreadGroupRow<TThread extends GroupableThread> =
  | {
      readonly kind: "header";
      readonly group: SidebarThreadGroup<TThread>;
      readonly depth: number;
      /** The section this one sits inside, or null at the top level. */
      readonly parentKey: string | null;
      /**
       * Every section at this level, in the order they render. Carried on the
       * row so a reorder never has to recover the level by parsing keys or
       * re-walking the tree: a drop and a Move up both rewrite exactly this
       * list.
       */
      readonly siblingKeys: ReadonlyArray<string>;
      /** This section's position within `siblingKeys`. */
      readonly index: number;
    }
  | { readonly kind: "thread"; readonly thread: TThread; readonly depth: number }
  | {
      readonly kind: "settled-header";
      readonly group: SidebarThreadGroup<TThread>;
      readonly depth: number;
      readonly expanded: boolean;
    }
  | { readonly kind: "settled-thread"; readonly thread: TThread; readonly depth: number }
  | {
      readonly kind: "settled-more";
      readonly group: SidebarThreadGroup<TThread>;
      readonly depth: number;
      readonly hiddenCount: number;
    };

/**
 * Collapse key of a section's history shelf.
 *
 * Namespaced under the section so expanding one project's history says nothing
 * about any other, and so the key can never collide with a section key.
 */
export function settledShelfKey(groupKey: string): string {
  return `${groupKey}/settled`;
}

export function flattenSidebarThreadGroups<TThread extends GroupableThread>(
  groups: ReadonlyArray<SidebarThreadGroup<TThread>>,
  collapsedGroupKeys: ReadonlySet<string>,
  options?: {
    /**
     * History shelves the user opened. Opt-in rather than opt-out: a section's
     * archive is closed until asked for, so history never pushes live work off
     * the screen on first paint.
     */
    readonly expandedSettledKeys?: ReadonlySet<string>;
    /**
     * How many settled rows an open shelf shows before offering the rest.
     * Omitted means no limit.
     */
    readonly settledPageSize?: number;
    /** Shelves the user asked to see in full, exempt from `settledPageSize`. */
    readonly fullSettledKeys?: ReadonlySet<string>;
  },
): Array<SidebarThreadGroupRow<TThread>> {
  const expandedSettledKeys = options?.expandedSettledKeys ?? EMPTY_KEYS;
  const fullSettledKeys = options?.fullSettledKeys ?? EMPTY_KEYS;
  const settledPageSize = options?.settledPageSize;
  const walk = (
    level: ReadonlyArray<SidebarThreadGroup<TThread>>,
    depth: number,
    parentKey: string | null,
  ): Array<SidebarThreadGroupRow<TThread>> => {
    const rows: Array<SidebarThreadGroupRow<TThread>> = [];
    const siblingKeys = level.map((group) => group.key);
    for (const [index, group] of level.entries()) {
      rows.push({ kind: "header", group, depth, parentKey, siblingKeys, index });
      if (collapsedGroupKeys.has(group.key)) {
        continue;
      }
      for (const thread of group.threads) {
        rows.push({ kind: "thread", thread, depth: depth + 1 });
      }
      rows.push(...walk(group.children, depth + 1, group.key));
      // History sits after the live rows and after any nested sections: it is
      // the tail of this section, not an item competing with them.
      if (group.settledThreads.length > 0) {
        const shelfKey = settledShelfKey(group.key);
        const expanded = expandedSettledKeys.has(shelfKey);
        rows.push({ kind: "settled-header", group, depth: depth + 1, expanded });
        if (expanded) {
          const limit =
            settledPageSize === undefined || fullSettledKeys.has(shelfKey)
              ? group.settledThreads.length
              : settledPageSize;
          for (const thread of group.settledThreads.slice(0, limit)) {
            rows.push({ kind: "settled-thread", thread, depth: depth + 1 });
          }
          const hiddenCount = group.settledThreads.length - limit;
          if (hiddenCount > 0) {
            rows.push({ kind: "settled-more", group, depth: depth + 1, hiddenCount });
          }
        }
      }
    }
    return rows;
  };
  return walk(groups, 0, null);
}

const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

export { UNKNOWN_PROVIDER_DRIVER };
