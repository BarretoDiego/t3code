import type { EnvironmentId, ProjectId, SidebarThreadGroupingAxis } from "@t3tools/contracts";

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

export interface SidebarThreadGroup<TThread extends GroupableThread> {
  /** Stable key for collapse persistence and React keys. Unique within the tree. */
  readonly key: string;
  readonly label: string;
  readonly axis: Exclude<SidebarThreadGroupingAxis, "none">;
  /** Threads directly in this section — empty when `children` carries them instead. */
  readonly threads: ReadonlyArray<TThread>;
  /** Nested sections when a secondary axis is active. */
  readonly children: ReadonlyArray<SidebarThreadGroup<TThread>>;
  /** Total threads in this section, including every descendant. */
  readonly threadCount: number;
  /** Attention rollup over every thread in this section, including descendants. */
  readonly attention: SidebarAttentionCounts;
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
}

function bucketForAxis(
  thread: GroupableThread,
  axis: Exclude<SidebarThreadGroupingAxis, "none">,
  context: SidebarThreadGroupContext,
): BucketIdentity {
  switch (axis) {
    case "environment": {
      const label = context.resolveEnvironmentLabel(thread.environmentId);
      return {
        key: `environment:${thread.environmentId}`,
        label: label ?? "This computer",
      };
    }
    case "project": {
      const label = context.resolveProjectLabel(thread.environmentId, thread.projectId);
      return {
        key: `project:${thread.environmentId}:${thread.projectId}`,
        label: label ?? "Unknown project",
      };
    }
    case "provider": {
      const identity = resolveThreadProviderIdentity(thread, context.providerEntriesByEnvironment);
      return { key: `provider:${identity.driverKind}`, label: identity.label };
    }
  }
}

function partitionByAxis<TThread extends GroupableThread>(
  threads: ReadonlyArray<TThread>,
  axis: Exclude<SidebarThreadGroupingAxis, "none">,
  context: SidebarThreadGroupContext,
): Array<{ identity: BucketIdentity; threads: TThread[] }> {
  const buckets = new Map<string, { identity: BucketIdentity; threads: TThread[] }>();
  for (const thread of threads) {
    const identity = bucketForAxis(thread, axis, context);
    const existing = buckets.get(identity.key);
    if (existing) {
      existing.threads.push(thread);
    } else {
      buckets.set(identity.key, { identity, threads: [thread] });
    }
  }
  return [...buckets.values()];
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
  readonly primaryAxis: SidebarThreadGroupingAxis;
  readonly secondaryAxis: SidebarThreadGroupingAxis;
  readonly context: SidebarThreadGroupContext;
}): ReadonlyArray<SidebarThreadGroup<TThread>> {
  const { primaryAxis, secondaryAxis, context, threads } = input;
  if (primaryAxis === "none" || threads.length === 0) {
    return [];
  }

  const nestedAxis =
    secondaryAxis === "none" || secondaryAxis === primaryAxis ? null : secondaryAxis;

  return partitionByAxis(threads, primaryAxis, context).map(({ identity, threads: bucket }) => {
    const attention = countAttention(bucket, context.classifyAttention);
    if (nestedAxis === null) {
      return {
        key: identity.key,
        label: identity.label,
        axis: primaryAxis,
        threads: bucket,
        children: [],
        threadCount: bucket.length,
        attention,
      } satisfies SidebarThreadGroup<TThread>;
    }

    const children = partitionByAxis(bucket, nestedAxis, context).map(
      (child): SidebarThreadGroup<TThread> => ({
        // Prefixed with the parent key so the same child bucket under two
        // parents gets two independent collapse states.
        key: `${identity.key}/${child.identity.key}`,
        label: child.identity.label,
        axis: nestedAxis,
        threads: child.threads,
        children: [],
        threadCount: child.threads.length,
        attention: countAttention(child.threads, context.classifyAttention),
      }),
    );

    return {
      key: identity.key,
      label: identity.label,
      axis: primaryAxis,
      threads: [],
      children,
      threadCount: bucket.length,
      attention,
    } satisfies SidebarThreadGroup<TThread>;
  });
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
  | { readonly kind: "header"; readonly group: SidebarThreadGroup<TThread>; readonly depth: number }
  | { readonly kind: "thread"; readonly thread: TThread; readonly depth: number };

export function flattenSidebarThreadGroups<TThread extends GroupableThread>(
  groups: ReadonlyArray<SidebarThreadGroup<TThread>>,
  collapsedGroupKeys: ReadonlySet<string>,
  depth = 0,
): Array<SidebarThreadGroupRow<TThread>> {
  const rows: Array<SidebarThreadGroupRow<TThread>> = [];
  for (const group of groups) {
    rows.push({ kind: "header", group, depth });
    if (collapsedGroupKeys.has(group.key)) {
      continue;
    }
    for (const thread of group.threads) {
      rows.push({ kind: "thread", thread, depth: depth + 1 });
    }
    rows.push(...flattenSidebarThreadGroups(group.children, collapsedGroupKeys, depth + 1));
  }
  return rows;
}

export { UNKNOWN_PROVIDER_DRIVER };
