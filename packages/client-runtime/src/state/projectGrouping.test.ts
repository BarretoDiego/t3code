import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  planProjectGroupLink,
  type ProjectGroup,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "Custom project" }),
      makeProject("second", "/work/t3code-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "t3code" }),
      makeProject("second", "/work/t3code-2", { title: "t3code" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "T3 Code",
    );
  });

  it("keeps physical clones in separate groups when requested", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["t3code", "t3code-2", "t3code-3"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/t3code", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/t3code/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("linked projects", () => {
  const laptop = EnvironmentId.make("laptop");
  const server = EnvironmentId.make("server");

  function linkSide(group: ProjectGroup) {
    return { key: group.key, members: group.members.map((member) => member.project) };
  }

  function applyLink(
    projects: ReadonlyArray<EnvironmentProject>,
    source: ProjectGroup,
    target: ProjectGroup,
  ): EnvironmentProject[] {
    const plan = planProjectGroupLink({
      source: linkSide(source),
      target: linkSide(target),
      makeLinkKey: () => "fresh",
    });
    const updated = new Set(plan.updates.map((ref) => `${ref.environmentId}:${ref.projectId}`));
    return projects.map((project) =>
      updated.has(`${project.environmentId}:${project.id}`)
        ? { ...project, linkKey: plan.linkKey }
        : project,
    );
  }

  function groupFor(groups: ReadonlyArray<ProjectGroup>, id: string): ProjectGroup {
    return groups.find((group) => group.members.some((member) => member.project.id === id))!;
  }

  it("pairs remote-less projects across environments with a fresh key", () => {
    const projects = [
      makeProject("notes-laptop", "/home/me/notes", {
        environmentId: laptop,
        repositoryIdentity: null,
      }),
      makeProject("notes-server", "/srv/notes", {
        environmentId: server,
        repositoryIdentity: null,
      }),
    ];
    const before = buildProjectGroups({ projects, settings: settings("repository") });
    expect(before).toHaveLength(2);

    const linked = applyLink(
      projects,
      groupFor(before, "notes-laptop"),
      groupFor(before, "notes-server"),
    );
    expect(linked.map((project) => project.linkKey)).toEqual(["link:fresh", "link:fresh"]);
    const after = buildProjectGroups({ projects: linked, settings: settings("repository") });
    expect(after).toHaveLength(1);
    expect(after[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("joins a remote-less project to a repository group without splitting it", () => {
    const projects = [
      makeProject("t3code-laptop", "/home/me/t3code", { environmentId: laptop }),
      makeProject("t3code-server", "/srv/t3code", { environmentId: server }),
      makeProject("t3code-copy", "/tmp/t3code", { repositoryIdentity: null }),
    ];
    const before = buildProjectGroups({ projects, settings: settings("repository") });
    expect(before).toHaveLength(2);

    const linked = applyLink(
      projects,
      groupFor(before, "t3code-copy"),
      groupFor(before, "t3code-laptop"),
    );
    expect(linked.map((project) => project.linkKey ?? null)).toEqual([
      null,
      null,
      repositoryIdentity.canonicalKey,
    ]);
    expect(buildProjectGroups({ projects: linked, settings: settings("repository") })).toHaveLength(
      1,
    );
  });

  it("returns an unlinked project to its own group and ignores links in separate mode", () => {
    const projects = [
      makeProject("a", "/a", {
        environmentId: laptop,
        repositoryIdentity: null,
        linkKey: "link:x",
      }),
      makeProject("b", "/b", {
        environmentId: server,
        repositoryIdentity: null,
        linkKey: "link:x",
      }),
    ];
    expect(buildProjectGroups({ projects, settings: settings("repository") })).toHaveLength(1);
    expect(buildProjectGroups({ projects, settings: settings("separate") })).toHaveLength(2);

    const unlinked = [projects[0]!, { ...projects[1]!, linkKey: null }];
    expect(
      buildProjectGroups({ projects: unlinked, settings: settings("repository") }),
    ).toHaveLength(2);
  });
});
