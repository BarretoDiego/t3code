import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  firstValidTimestamp,
  firstValidTimestampMs,
  sortSettledThreadsForSidebar,
  sortThreadsForSidebar,
} from "./components/Sidebar.logic";

/**
 * The two aggregate views the breadcrumb points at: everything in one
 * environment, and everything in one project.
 *
 * Both answer "what is in here" for a scope the user just clicked, so the
 * shelves they show and the order inside them follow the sidebar's rules
 * rather than inventing a second definition of what an active thread is.
 */

/**
 * The environment label a crumb can actually show, or null when there is
 * nothing worth rendering.
 *
 * A server names itself in its descriptor, and nothing forces that name to be
 * non-empty. A blank chip in the path is worse than no chip at all, so an
 * empty label reads as "no environment to show" rather than rendering an icon
 * with nothing next to it.
 */
export function resolveScopeEnvironmentLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

export interface ScopeThreadShelves<TThread> {
  readonly active: ReadonlyArray<TThread>;
  readonly snoozed: ReadonlyArray<TThread>;
  readonly settled: ReadonlyArray<TThread>;
}

/**
 * Splits a scope's threads into the shelves the page renders.
 *
 * Deliberately the sidebar's rule: settlement is stamped server-side (manual
 * override or the auto-settle reactor reading the server's own settle
 * settings), so shelving reads the stamp and never re-derives it here.
 *
 * Capability probes are injected because both are per-environment: a server
 * too old to settle or snooze must never have its threads filed under a shelf
 * it cannot undo.
 */
export function shelveScopeThreads<TThread extends EnvironmentThreadShell>(input: {
  readonly threads: ReadonlyArray<TThread>;
  readonly now: string;
  readonly supportsSettlement: (environmentId: EnvironmentId) => boolean;
  readonly supportsSnooze: (environmentId: EnvironmentId) => boolean;
}): ScopeThreadShelves<TThread> {
  const active: TThread[] = [];
  const snoozed: TThread[] = [];
  const settled: TThread[] = [];
  for (const thread of input.threads) {
    // Snooze outranks settlement, exactly as in the sidebar: a snoozed thread
    // is one you asked to hear from later, not one you are done with.
    // Settlement itself is server-stamped (manual override or the server's
    // auto-settle reactor), so the row reads `settledOverride` directly.
    if (
      input.supportsSnooze(thread.environmentId) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      snoozed.push(thread);
    } else if (
      input.supportsSettlement(thread.environmentId) &&
      thread.settledOverride === "settled" &&
      // Blocked work stays visible even when a server stamped it settled:
      // hiding a thread that is waiting on you buries the one row that
      // needs attention.
      !thread.hasPendingApprovals &&
      !thread.hasPendingUserInput
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }
  return {
    active: sortThreadsForSidebar(active),
    // Soonest wake first — "what comes back next" is this shelf's question.
    snoozed: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settled: sortSettledThreadsForSidebar(settled),
  };
}

/** One row of the environment page: a project plus what is going on in it. */
export interface EnvironmentProjectSummary<TProject> {
  readonly project: TProject;
  /** Threads on no shelf — the count the row leads with. */
  readonly activeThreadCount: number;
  readonly threadCount: number;
  /**
   * Newest thread activity, falling back to the project's own timestamp when
   * it has no threads at all. Doubles as the sort key, so a project you just
   * added does not sink below ones you have not touched in weeks.
   */
  readonly lastActivityAt: string | null;
}

/**
 * The environment page's rows: every project on that server, busiest first.
 *
 * Rows come from the environment's project list rather than from its threads,
 * so a project you added and have not opened yet still gets one — the same
 * promise the sidebar makes with its seeded sections.
 */
export function summarizeEnvironmentProjects<
  TProject extends Pick<EnvironmentProject, "environmentId" | "id" | "createdAt" | "updatedAt">,
  TThread extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "updatedAt">,
>(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<TProject>;
  readonly threads: ReadonlyArray<TThread>;
  /** Threads the page counts as live work. Everything else only adds to the total. */
  readonly isActiveThread: (thread: TThread) => boolean;
}): ReadonlyArray<EnvironmentProjectSummary<TProject>> {
  const threadsByProjectId = new Map<ProjectId, TThread[]>();
  for (const thread of input.threads) {
    if (thread.environmentId !== input.environmentId) continue;
    const existing = threadsByProjectId.get(thread.projectId);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectId.set(thread.projectId, [thread]);
    }
  }
  const summaries = input.projects
    .filter((project) => project.environmentId === input.environmentId)
    .map((project): EnvironmentProjectSummary<TProject> => {
      const threads = threadsByProjectId.get(project.id) ?? [];
      const newestThreadAt = threads.reduce<string | null>(
        (newest, thread) =>
          newest === null || firstValidTimestampMs(thread.updatedAt) > firstValidTimestampMs(newest)
            ? thread.updatedAt
            : newest,
        null,
      );
      return {
        project,
        activeThreadCount: threads.filter((thread) => input.isActiveThread(thread)).length,
        threadCount: threads.length,
        lastActivityAt:
          newestThreadAt ?? firstValidTimestamp(project.updatedAt, project.createdAt) ?? null,
      };
    });
  return summaries.toSorted(
    (left, right) =>
      firstValidTimestampMs(right.lastActivityAt) - firstValidTimestampMs(left.lastActivityAt),
  );
}
