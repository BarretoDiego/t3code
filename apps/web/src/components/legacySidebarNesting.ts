import {
  buildThreadNesting,
  flattenThreadNesting,
  type ThreadNesting,
  type ThreadNestingSummary,
  type ThreadNestingThread,
  type ThreadNestingRow,
} from "@t3tools/client-runtime/state/thread-relationships";

/**
 * The legacy sidebar lists threads per project. This applies the shared
 * nesting forest to one project's list: subagent threads sit indented under
 * the thread that started them, and only top-level threads count toward the
 * preview limit and the jump shortcuts.
 */

export interface LegacyProjectNesting<T> {
  readonly nesting: ThreadNesting<T>;
  /** Top-level rows in the caller's sort order. */
  readonly topLevel: ReadonlyArray<T>;
}

export type LegacyThreadRow<T> =
  | Extract<ThreadNestingRow<T>, { kind: "settled" }>
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: T;
      /** 0 for a top-level row. */
      readonly depth: number;
      /** Set on a row that has subagents under it. */
      readonly summary: ThreadNestingSummary | null;
      readonly expanded: boolean;
    };

const NO_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * `sortedThreads` is the project's unarchived threads in display order.
 * `archivedThreads` only lets a child tell an archived parent from a missing
 * one. A child whose parent belongs to another project takes a top-level row.
 */
export function nestLegacyProjectThreads<T extends ThreadNestingThread>(input: {
  readonly sortedThreads: ReadonlyArray<T>;
  readonly archivedThreads?: ReadonlyArray<T>;
}): LegacyProjectNesting<T> {
  const nesting = buildThreadNesting({
    threads: [...input.sortedThreads, ...(input.archivedThreads ?? [])],
    isListed: (thread) => thread.archivedAt === null,
  });
  return { nesting, topLevel: nesting.roots.map((root) => root.thread) };
}

/**
 * The rows to draw for the given top-level threads, each followed by its
 * subagents. Children show while one is working or waiting on the user, or
 * when the user opened them; the path to the open thread always shows.
 */
export function legacyProjectThreadRows<T extends ThreadNestingThread>(input: {
  readonly nesting: ThreadNesting<T>;
  readonly topLevel: ReadonlyArray<T>;
  readonly expandedOverrides: Readonly<Record<string, boolean>>;
  readonly activePathKeys: ReadonlySet<string>;
}): ReadonlyArray<LegacyThreadRow<T>> {
  const rows: Array<LegacyThreadRow<T>> = [];
  for (const thread of input.topLevel) {
    const key = `${thread.environmentId}:${thread.id}`;
    const node = input.nesting.nodeByKey.get(key);
    const display =
      node === undefined
        ? null
        : flattenThreadNesting({
            node,
            expandedOverrides: input.expandedOverrides,
            activePathKeys: input.activePathKeys,
            // The project's own "Show more" already bounds the list.
            childLimit: Number.POSITIVE_INFINITY,
            showAllKeys: NO_KEYS,
          });
    rows.push({
      kind: "thread",
      key,
      thread,
      depth: 0,
      summary: display?.summary ?? null,
      expanded: display?.expanded ?? false,
    });
    for (const row of display?.rows ?? []) {
      if (row.kind === "settled") {
        rows.push(row);
        continue;
      }
      if (row.kind !== "thread") continue;
      rows.push({
        kind: "thread",
        key: row.key,
        thread: row.thread,
        depth: row.depth,
        summary: row.summary,
        expanded: row.expanded,
      });
    }
  }
  return rows;
}

/** A nested thread shown on its own, such as the open thread of a collapsed project. */
export function legacyStandaloneRow<T extends ThreadNestingThread>(thread: T): LegacyThreadRow<T> {
  return {
    kind: "thread",
    key: `${thread.environmentId}:${thread.id}`,
    thread,
    depth: 0,
    summary: null,
    expanded: false,
  };
}
