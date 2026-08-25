import {
  ProjectSyncIoError,
  ProjectSyncPathViolationError,
  ProjectSyncProjectNotFoundError,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  ProjectSyncAbortedError,
  ProjectSyncTransferError,
  ProjectSyncUrlResolutionError,
  type ProjectSyncProgress,
} from "../state/projectSync.ts";
import { getAddProjectInitialQuery } from "./projects.ts";
import type { ProjectSyncPlanSummary } from "./projectSync.ts";

/**
 * Pure decision/presentation logic behind the "sync project between
 * environments" flow: which environments and projects can take part, what the
 * default destination folder is, how a run's progress and failures read, and
 * when the flow is allowed to start. Shared by web and mobile — nothing here
 * touches React, the DOM, or a socket.
 */

/**
 * One connected environment considered as a sync source/destination
 * candidate. Kept intentionally narrow (rather than the full presentation
 * type) so this module's pure functions are easy to unit test without
 * constructing a real `EnvironmentPresentation`.
 */
export interface SyncEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly projectSyncCapable: boolean;
}

/**
 * Environments eligible as either end of a sync: connected, and reporting the
 * `projectSync` capability. Older servers (or ones mid-reconnect) never show
 * up, since neither can safely serve the manifest/export/import RPCs.
 */
export function selectProjectSyncEnvironmentOptions(
  candidates: ReadonlyArray<SyncEnvironmentCandidate>,
): SyncEnvironmentCandidate[] {
  return candidates.filter((candidate) => candidate.connected && candidate.projectSyncCapable);
}

/**
 * Whether a specific environment can take part in a sync at all.
 *
 * The dialog's pickers only ever list eligible environments, but a fixed
 * source (Project Settings, or the palette's project-scoped entry) skips the
 * origin step entirely — so the source it was handed still has to be checked
 * against the same rule, or an old/disconnected server would only fail once
 * the manifest RPC came back.
 */
export function isProjectSyncEnvironmentEligible(
  candidates: ReadonlyArray<SyncEnvironmentCandidate>,
  environmentId: EnvironmentId | null,
): boolean {
  if (environmentId === null) {
    return false;
  }
  return selectProjectSyncEnvironmentOptions(candidates).some(
    (candidate) => candidate.environmentId === environmentId,
  );
}

export interface SyncProjectCandidate {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryCanonicalKey: string | null;
}

/**
 * Existing projects on the destination environment eligible as a "sync"
 * target, i.e. every project on that environment except the literal source
 * project (relevant when source and destination happen to be the same
 * environment).
 */
export function selectDestinationProjectCandidates(input: {
  readonly allProjects: ReadonlyArray<SyncProjectCandidate>;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly source: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
}): SyncProjectCandidate[] {
  return input.allProjects.filter(
    (project) =>
      project.environmentId === input.destinationEnvironmentId &&
      !(
        project.environmentId === input.source.environmentId &&
        project.projectId === input.source.projectId
      ),
  );
}

/**
 * Stable-sorts destination candidates so projects sharing the source's
 * repository identity are suggested first. Array#sort is a stable sort in
 * every engine this app targets, so ties preserve the caller's original
 * (e.g. alphabetical) order.
 */
export function sortDestinationProjectCandidatesBySourceMatch(input: {
  readonly candidates: ReadonlyArray<SyncProjectCandidate>;
  readonly sourceRepositoryCanonicalKey: string | null;
}): SyncProjectCandidate[] {
  const key = input.sourceRepositoryCanonicalKey;
  if (key === null) {
    return [...input.candidates];
  }
  return [...input.candidates].sort((a, b) => {
    const aRank = a.repositoryCanonicalKey === key ? 0 : 1;
    const bRank = b.repositoryCanonicalKey === key ? 0 : 1;
    return aRank - bRank;
  });
}

/** Turns a project title into a filesystem-safe folder name for the default
    "send" destination path. Falls back to "project" if nothing survives. */
export function slugifyProjectFolderName(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/**
 * Default destination path for a "send" (new project) sync: the destination
 * environment's configured `addProjectBaseDirectory` (or `~/` when unset),
 * plus a slug of the source project's title. The base folder comes from
 * `getAddProjectInitialQuery`, the same rule the add-project flow uses, so
 * both surfaces propose folders under the same directory.
 */
export function buildDefaultSendDestinationPath(input: {
  readonly baseDirectory: string;
  readonly sourceProjectTitle: string;
}): string {
  const directory = getAddProjectInitialQuery(input.baseDirectory);
  return `${directory}${slugifyProjectFolderName(input.sourceProjectTitle)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Maps a `ProjectSyncProgress` snapshot to a 0-100 percentage for a progress
 * bar. Bytes drive the percentage whenever the plan has any; a delete-only
 * plan (no bytes to copy) falls back to file counts, and a plan with neither
 * is already complete the moment the copy stage starts.
 */
export function deriveProjectSyncProgressPercent(progress: ProjectSyncProgress): number {
  switch (progress.stage) {
    case "manifest":
    case "planning":
      return 0;
    case "done":
    case "deleting":
      return 100;
    case "transferring":
      if (progress.totalBytes > 0) {
        return clampPercent((progress.transferredBytes / progress.totalBytes) * 100);
      }
      if (progress.totalFiles > 0) {
        return clampPercent((progress.transferredFiles / progress.totalFiles) * 100);
      }
      return 100;
  }
}

export function describeProjectSyncStage(stage: ProjectSyncProgress["stage"]): string {
  switch (stage) {
    case "manifest":
      return "Reading file lists…";
    case "planning":
      return "Comparing projects…";
    case "transferring":
      return "Copying files…";
    case "deleting":
      return "Removing files no longer in the source…";
    case "done":
      return "Done";
  }
}

export interface SyncProjectErrorDescription {
  readonly title: string;
  readonly message: string;
  readonly canRetry: boolean;
}

/** Signed export/import URLs are short-lived and budget-bound, so the handful
    of statuses the endpoints can answer with each mean something specific to
    the user. Anything else falls back to the raw failure text. */
function describeTransferFailureMessage(error: ProjectSyncTransferError): string {
  switch (error.status) {
    case 404:
      return "The transfer link expired before the batch finished. Try again.";
    case 413:
      return "The destination rejected the transfer because a batch was too large.";
    case 400:
      return "The destination rejected one or more file paths.";
    default:
      return error.message;
  }
}

/**
 * The destination refuses to create a second project over a workspace root it
 * already tracks. That is the one "send" failure a user can act on directly,
 * so it gets its own wording instead of the raw invariant text the
 * orchestration layer produces.
 */
const WORKSPACE_ROOT_TAKEN_PATTERN = /already exists for workspace root/i;

const isProjectSyncProjectNotFoundError = Schema.is(ProjectSyncProjectNotFoundError);
const isProjectSyncPathViolationError = Schema.is(ProjectSyncPathViolationError);
const isProjectSyncIoError = Schema.is(ProjectSyncIoError);

/** Maps any error `runProjectSync` can throw (or reject with) to a
    human-readable title/message and whether a retry is worth offering. */
export function describeProjectSyncError(error: unknown): SyncProjectErrorDescription {
  if (error instanceof ProjectSyncAbortedError) {
    return {
      title: "Sync cancelled",
      message: "The sync was cancelled before it finished.",
      canRetry: true,
    };
  }
  if (error instanceof ProjectSyncUrlResolutionError) {
    return {
      title: "Connection lost",
      message: `Could not reach environment "${error.environmentId}". Check its connection and try again.`,
      canRetry: true,
    };
  }
  if (error instanceof ProjectSyncTransferError) {
    return {
      title: "Transfer failed",
      message: describeTransferFailureMessage(error),
      canRetry: true,
    };
  }

  const message =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : null;

  // Checked before the tagged cases below: the occupied-folder failure arrives
  // wrapped in whatever error the dispatching command produced, so only its
  // text identifies it.
  if (message !== null && WORKSPACE_ROOT_TAKEN_PATTERN.test(message)) {
    return {
      title: "Folder already in use",
      message:
        "The destination environment already has a project at that folder. Pick a different folder, or use “Sync an existing project” to sync into it.",
      canRetry: false,
    };
  }
  if (isProjectSyncProjectNotFoundError(error)) {
    return {
      title: "Project not found",
      message: error.message,
      canRetry: false,
    };
  }
  if (isProjectSyncPathViolationError(error)) {
    return {
      title: "Blocked file path",
      message: error.message,
      canRetry: false,
    };
  }
  if (isProjectSyncIoError(error)) {
    return {
      title: "File operation failed",
      message: error.message,
      canRetry: true,
    };
  }

  if (error instanceof Error) {
    return { title: "Sync failed", message: error.message, canRetry: true };
  }
  return { title: "Sync failed", message: "Sync failed for an unknown reason.", canRetry: true };
}

/** Whether a sync plan requires the user to explicitly acknowledge deletions
    before starting — deletions mirror the destination onto the source, so
    they are the one part of a sync that is not simply additive. */
export function projectSyncPlanNeedsDeleteConfirmation(summary: {
  readonly deleteCount: number;
}): boolean {
  return summary.deleteCount > 0;
}

/**
 * Formats a byte count for a sync plan summary. Deliberately drops the
 * fractional part once it is meaningless ("2 KB", not "2.00 KB"): a plan
 * summary is a one-line size estimate, not a measurement. The diagnostics
 * panels' own `formatBytes` helpers keep two decimals instead because they
 * render live telemetry where small deltas matter — that difference is
 * intentional, not drift.
 */
export function formatProjectSyncBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function describeProjectSyncPlanSummary(summary: ProjectSyncPlanSummary): string {
  const copyPart = summary.copyCount === 1 ? "1 file" : `${summary.copyCount} files`;
  const bytesPart = formatProjectSyncBytes(summary.copyBytes);
  const deletePart =
    summary.deleteCount > 0
      ? `, ${summary.deleteCount === 1 ? "1 file" : `${summary.deleteCount} files`} removed`
      : "";
  return `${copyPart} to copy (${bytesPart})${deletePart}`;
}

export type SyncProjectDialogStepId = "origin" | "destination" | "mode" | "review" | "progress";

/**
 * The dialog skips the origin step entirely when it was opened with a fixed
 * source project (from Project Settings, or the command palette's
 * project-scoped entry) — asking again would ignore where the request came
 * from, the same rule the add-project flow already follows.
 */
export function buildSyncProjectDialogSteps(input: {
  readonly hasFixedSource: boolean;
}): SyncProjectDialogStepId[] {
  return input.hasFixedSource
    ? ["destination", "mode", "review", "progress"]
    : ["origin", "destination", "mode", "review", "progress"];
}

export type SyncProjectDialogMode = "send" | "sync";

/** Gates the review step's "Start sync" action. */
export function canStartProjectSync(input: {
  readonly mode: SyncProjectDialogMode | null;
  readonly sendDestinationPath: string;
  readonly existingDestinationProjectId: ProjectId | null;
  readonly planSummary: { readonly deleteCount: number } | null;
  readonly deleteConfirmed: boolean;
}): boolean {
  if (input.mode === null) {
    return false;
  }
  if (input.mode === "send") {
    return input.sendDestinationPath.trim().length > 0;
  }
  if (input.existingDestinationProjectId === null || input.planSummary === null) {
    return false;
  }
  if (input.planSummary.deleteCount > 0 && !input.deleteConfirmed) {
    return false;
  }
  return true;
}
