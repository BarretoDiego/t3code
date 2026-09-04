import {
  EnvironmentId,
  ProjectId,
  ProjectSyncIoError,
  ProjectSyncPathViolationError,
  ProjectSyncProjectNotFoundError,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectSyncAbortedError,
  ProjectSyncTransferError,
  ProjectSyncUrlResolutionError,
  type ProjectSyncProgress,
} from "../state/projectSync.ts";
import {
  buildDefaultSendDestinationPath,
  buildSyncProjectDialogSteps,
  canStartProjectSync,
  describeProjectSyncError,
  describeProjectSyncPlanSummary,
  deriveProjectSyncProgressPercent,
  describeProjectSyncStage,
  formatProjectSyncBytes,
  isProjectSyncEnvironmentEligible,
  projectSyncPlanNeedsDeleteConfirmation,
  selectDestinationProjectCandidates,
  selectProjectSyncEnvironmentOptions,
  slugifyProjectFolderName,
  sortDestinationProjectCandidatesBySourceMatch,
  type SyncEnvironmentCandidate,
  type SyncProjectCandidate,
} from "./projectSyncFlow.ts";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const PROJECT_1 = ProjectId.make("project-1");
const PROJECT_2 = ProjectId.make("project-2");
const PROJECT_3 = ProjectId.make("project-3");

function envCandidate(overrides: Partial<SyncEnvironmentCandidate> = {}): SyncEnvironmentCandidate {
  return {
    environmentId: ENV_A,
    label: "Env A",
    connected: true,
    projectSyncCapable: true,
    ...overrides,
  };
}

function projectCandidate(overrides: Partial<SyncProjectCandidate> = {}): SyncProjectCandidate {
  return {
    environmentId: ENV_B,
    projectId: PROJECT_2,
    title: "Project",
    workspaceRoot: "/workspace/project",
    repositoryCanonicalKey: null,
    ...overrides,
  };
}

function progress(overrides: Partial<ProjectSyncProgress> = {}): ProjectSyncProgress {
  return {
    stage: "transferring",
    transferredBytes: 0,
    totalBytes: 0,
    transferredFiles: 0,
    totalFiles: 0,
    ...overrides,
  };
}

describe("selectProjectSyncEnvironmentOptions", () => {
  it("keeps only connected, capability-flagged environments", () => {
    const candidates = [
      envCandidate({ environmentId: ENV_A, connected: true, projectSyncCapable: true }),
      envCandidate({ environmentId: ENV_B, connected: false, projectSyncCapable: true }),
      envCandidate({
        environmentId: EnvironmentId.make("env-c"),
        connected: true,
        projectSyncCapable: false,
      }),
    ];
    expect(selectProjectSyncEnvironmentOptions(candidates)).toEqual([candidates[0]]);
  });
});

describe("isProjectSyncEnvironmentEligible", () => {
  const candidates = [
    envCandidate({ environmentId: ENV_A, connected: true, projectSyncCapable: true }),
    envCandidate({ environmentId: ENV_B, connected: true, projectSyncCapable: false }),
    envCandidate({
      environmentId: EnvironmentId.make("env-c"),
      connected: false,
      projectSyncCapable: true,
    }),
  ];

  it("accepts a connected, capable environment", () => {
    expect(isProjectSyncEnvironmentEligible(candidates, ENV_A)).toBe(true);
  });

  it("rejects an environment whose server does not support sync", () => {
    expect(isProjectSyncEnvironmentEligible(candidates, ENV_B)).toBe(false);
  });

  it("rejects a disconnected environment", () => {
    expect(isProjectSyncEnvironmentEligible(candidates, EnvironmentId.make("env-c"))).toBe(false);
  });

  it("rejects an unknown or absent environment", () => {
    expect(isProjectSyncEnvironmentEligible(candidates, EnvironmentId.make("env-gone"))).toBe(
      false,
    );
    expect(isProjectSyncEnvironmentEligible(candidates, null)).toBe(false);
  });
});

describe("selectDestinationProjectCandidates", () => {
  it("filters to the destination environment and excludes the literal source project", () => {
    const source = { environmentId: ENV_A, projectId: PROJECT_1 };
    const candidates = [
      projectCandidate({ environmentId: ENV_A, projectId: PROJECT_1 }), // same env+project as source
      projectCandidate({ environmentId: ENV_A, projectId: PROJECT_2 }), // same env, different project
      projectCandidate({ environmentId: ENV_B, projectId: PROJECT_3 }), // different env entirely
    ];

    const result = selectDestinationProjectCandidates({
      allProjects: candidates,
      destinationEnvironmentId: ENV_A,
      source,
    });

    expect(result).toEqual([candidates[1]]);
  });
});

describe("sortDestinationProjectCandidatesBySourceMatch", () => {
  it("moves repository-matching candidates first, preserving relative order otherwise", () => {
    const candidates = [
      projectCandidate({ projectId: PROJECT_1, repositoryCanonicalKey: "other" }),
      projectCandidate({ projectId: PROJECT_2, repositoryCanonicalKey: "match" }),
      projectCandidate({ projectId: PROJECT_3, repositoryCanonicalKey: null }),
    ];

    const result = sortDestinationProjectCandidatesBySourceMatch({
      candidates,
      sourceRepositoryCanonicalKey: "match",
    });

    expect(result.map((candidate) => candidate.projectId)).toEqual([
      PROJECT_2,
      PROJECT_1,
      PROJECT_3,
    ]);
  });

  it("returns candidates unchanged when the source has no repository identity", () => {
    const candidates = [
      projectCandidate({ projectId: PROJECT_1 }),
      projectCandidate({ projectId: PROJECT_2 }),
    ];
    expect(
      sortDestinationProjectCandidatesBySourceMatch({
        candidates,
        sourceRepositoryCanonicalKey: null,
      }),
    ).toEqual(candidates);
  });
});

describe("slugifyProjectFolderName", () => {
  it("replaces path-unsafe characters and whitespace with dashes", () => {
    expect(slugifyProjectFolderName("My App: v2/final")).toBe("My-App-v2-final");
  });

  it("collapses repeated separators and trims leading/trailing dashes", () => {
    expect(slugifyProjectFolderName("  ///weird///  ")).toBe("weird");
  });

  it("falls back to 'project' when nothing survives", () => {
    expect(slugifyProjectFolderName("///")).toBe("project");
  });
});

describe("buildDefaultSendDestinationPath", () => {
  it("joins the configured base directory with a slug of the source title", () => {
    expect(
      buildDefaultSendDestinationPath({
        baseDirectory: "/home/user/code",
        sourceProjectTitle: "My App",
      }),
    ).toBe("/home/user/code/My-App");
  });

  it("falls back to ~/ when no base directory is configured", () => {
    expect(
      buildDefaultSendDestinationPath({ baseDirectory: "", sourceProjectTitle: "My App" }),
    ).toBe("~/My-App");
  });

  it("does not duplicate an existing trailing separator", () => {
    expect(
      buildDefaultSendDestinationPath({
        baseDirectory: "/home/user/code/",
        sourceProjectTitle: "App",
      }),
    ).toBe("/home/user/code/App");
  });
});

describe("deriveProjectSyncProgressPercent", () => {
  it("reports 0 while reading manifests or planning", () => {
    expect(deriveProjectSyncProgressPercent(progress({ stage: "manifest" }))).toBe(0);
    expect(deriveProjectSyncProgressPercent(progress({ stage: "planning" }))).toBe(0);
  });

  it("reports 100 once deleting or done", () => {
    expect(deriveProjectSyncProgressPercent(progress({ stage: "deleting" }))).toBe(100);
    expect(deriveProjectSyncProgressPercent(progress({ stage: "done" }))).toBe(100);
  });

  it("derives a percentage from bytes while transferring", () => {
    expect(
      deriveProjectSyncProgressPercent(
        progress({ stage: "transferring", transferredBytes: 25, totalBytes: 100 }),
      ),
    ).toBe(25);
  });

  it("falls back to file counts when there are no bytes to copy", () => {
    expect(
      deriveProjectSyncProgressPercent(
        progress({ stage: "transferring", totalBytes: 0, transferredFiles: 1, totalFiles: 4 }),
      ),
    ).toBe(25);
  });

  it("reports complete immediately when the plan has neither bytes nor files", () => {
    expect(deriveProjectSyncProgressPercent(progress({ stage: "transferring" }))).toBe(100);
  });
});

describe("describeProjectSyncStage", () => {
  it("labels every stage the controller can report", () => {
    expect(describeProjectSyncStage("manifest")).toBe("Reading file lists…");
    expect(describeProjectSyncStage("planning")).toBe("Comparing projects…");
    expect(describeProjectSyncStage("transferring")).toBe("Copying files…");
    expect(describeProjectSyncStage("deleting")).toBe("Removing files no longer in the source…");
    expect(describeProjectSyncStage("done")).toBe("Done");
  });
});

describe("describeProjectSyncError", () => {
  it("describes an aborted sync as retryable", () => {
    const result = describeProjectSyncError(new ProjectSyncAbortedError());
    expect(result.canRetry).toBe(true);
    expect(result.title).toBe("Sync cancelled");
  });

  it("names the unreachable environment for a URL resolution failure", () => {
    const result = describeProjectSyncError(new ProjectSyncUrlResolutionError(ENV_A));
    expect(result.message).toContain(ENV_A);
    expect(result.canRetry).toBe(true);
  });

  it("translates a 404 transfer failure into an expired-link message", () => {
    const result = describeProjectSyncError(
      new ProjectSyncTransferError(
        "Import request to environment 'env-b' failed with status 404.",
        undefined,
        404,
      ),
    );
    expect(result.message).toBe("The transfer link expired before the batch finished. Try again.");
  });

  it("translates a 413 transfer failure into a too-large message", () => {
    const result = describeProjectSyncError(
      new ProjectSyncTransferError(
        "Import request to environment 'env-b' failed with status 413.",
        undefined,
        413,
      ),
    );
    expect(result.message).toContain("too large");
  });

  it("translates a 400 transfer failure into a rejected-paths message", () => {
    const result = describeProjectSyncError(
      new ProjectSyncTransferError(
        "Import request to environment 'env-b' failed with status 400.",
        undefined,
        400,
      ),
    );
    expect(result.message).toBe("The destination rejected one or more file paths.");
  });

  it("keeps the raw message for a transfer failure with no HTTP status", () => {
    // A network-level failure (fetch rejecting) carries no status, so a
    // status-shaped substring in the text must not be mistaken for one.
    const result = describeProjectSyncError(
      new ProjectSyncTransferError("Could not reach environment 'env-b' (status 404 route)."),
    );
    expect(result.message).toBe("Could not reach environment 'env-b' (status 404 route).");
  });

  it("maps a ProjectSyncPathViolationError to a non-retryable description", () => {
    const result = describeProjectSyncError(
      new ProjectSyncPathViolationError({
        path: "../etc",
        message: "Path '../etc' escapes the project workspace root.",
      }),
    );
    expect(result.canRetry).toBe(false);
    expect(result.message).toBe("Path '../etc' escapes the project workspace root.");
  });

  it("maps a ProjectSyncProjectNotFoundError to a non-retryable description", () => {
    const result = describeProjectSyncError(
      new ProjectSyncProjectNotFoundError({ projectId: "project-1" }),
    );
    expect(result.title).toBe("Project not found");
    expect(result.canRetry).toBe(false);
  });

  it("maps a ProjectSyncIoError to a retryable description", () => {
    const result = describeProjectSyncError(new ProjectSyncIoError({ message: "disk full" }));
    expect(result.canRetry).toBe(true);
    expect(result.message).toBe("disk full");
  });

  it("explains a destination folder that already belongs to another project", () => {
    // What a failed "send" into an occupied folder actually looks like: the
    // orchestration invariant text, wrapped in a dispatch error.
    const result = describeProjectSyncError({
      _tag: "OrchestrationDispatchCommandError",
      message:
        "Orchestration command invariant failed (project.create): Active project 'project-1' already exists for workspace root '/home/me/thing'.",
    });
    expect(result.title).toBe("Folder already in use");
    expect(result.canRetry).toBe(false);
    expect(result.message).toContain("Pick a different folder");
  });

  it("falls back to the error's own message for a plain Error", () => {
    const result = describeProjectSyncError(new Error("boom"));
    expect(result.message).toBe("boom");
  });

  it("falls back to a generic message for a non-error value", () => {
    const result = describeProjectSyncError("nope");
    expect(result.message).toBe("Sync failed for an unknown reason.");
  });
});

describe("formatProjectSyncBytes", () => {
  it("formats zero and sub-unit values", () => {
    expect(formatProjectSyncBytes(0)).toBe("0 B");
    expect(formatProjectSyncBytes(512)).toBe("512 B");
  });

  it("formats larger values with the appropriate unit", () => {
    expect(formatProjectSyncBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatProjectSyncBytes(1536)).toBe("1.5 KB");
  });
});

describe("describeProjectSyncPlanSummary", () => {
  it("describes a copy-only plan", () => {
    expect(describeProjectSyncPlanSummary({ copyCount: 3, deleteCount: 0, copyBytes: 2048 })).toBe(
      "3 files to copy (2 KB)",
    );
  });

  it("appends the delete count when the plan removes files", () => {
    expect(describeProjectSyncPlanSummary({ copyCount: 1, deleteCount: 1, copyBytes: 10 })).toBe(
      "1 file to copy (10 B), 1 file removed",
    );
  });
});

describe("projectSyncPlanNeedsDeleteConfirmation", () => {
  it("requires confirmation only when the plan deletes files", () => {
    expect(projectSyncPlanNeedsDeleteConfirmation({ deleteCount: 0 })).toBe(false);
    expect(projectSyncPlanNeedsDeleteConfirmation({ deleteCount: 2 })).toBe(true);
  });
});

describe("buildSyncProjectDialogSteps", () => {
  it("includes the origin step only when the source is not fixed", () => {
    expect(buildSyncProjectDialogSteps({ hasFixedSource: false })).toEqual([
      "origin",
      "destination",
      "mode",
      "review",
      "progress",
    ]);
    expect(buildSyncProjectDialogSteps({ hasFixedSource: true })).toEqual([
      "destination",
      "mode",
      "review",
      "progress",
    ]);
  });
});

describe("canStartProjectSync", () => {
  it("blocks when no mode is chosen", () => {
    expect(
      canStartProjectSync({
        mode: null,
        sendDestinationPath: "/x",
        existingDestinationProjectId: null,
        planSummary: null,
        deleteConfirmed: false,
      }),
    ).toBe(false);
  });

  it("requires a non-empty destination path for send", () => {
    expect(
      canStartProjectSync({
        mode: "send",
        sendDestinationPath: "   ",
        existingDestinationProjectId: null,
        planSummary: null,
        deleteConfirmed: false,
      }),
    ).toBe(false);
    expect(
      canStartProjectSync({
        mode: "send",
        sendDestinationPath: "/home/user/app",
        existingDestinationProjectId: null,
        planSummary: null,
        deleteConfirmed: false,
      }),
    ).toBe(true);
  });

  it("requires an existing project and a computed plan for sync", () => {
    expect(
      canStartProjectSync({
        mode: "sync",
        sendDestinationPath: "",
        existingDestinationProjectId: null,
        planSummary: { deleteCount: 0 },
        deleteConfirmed: false,
      }),
    ).toBe(false);
    expect(
      canStartProjectSync({
        mode: "sync",
        sendDestinationPath: "",
        existingDestinationProjectId: PROJECT_1,
        planSummary: null,
        deleteConfirmed: false,
      }),
    ).toBe(false);
  });

  it("blocks a deleting sync plan until deletions are explicitly confirmed", () => {
    expect(
      canStartProjectSync({
        mode: "sync",
        sendDestinationPath: "",
        existingDestinationProjectId: PROJECT_1,
        planSummary: { deleteCount: 2 },
        deleteConfirmed: false,
      }),
    ).toBe(false);
    expect(
      canStartProjectSync({
        mode: "sync",
        sendDestinationPath: "",
        existingDestinationProjectId: PROJECT_1,
        planSummary: { deleteCount: 2 },
        deleteConfirmed: true,
      }),
    ).toBe(true);
  });

  it("allows a non-deleting sync plan without explicit confirmation", () => {
    expect(
      canStartProjectSync({
        mode: "sync",
        sendDestinationPath: "",
        existingDestinationProjectId: PROJECT_1,
        planSummary: { deleteCount: 0 },
        deleteConfirmed: false,
      }),
    ).toBe(true);
  });
});
