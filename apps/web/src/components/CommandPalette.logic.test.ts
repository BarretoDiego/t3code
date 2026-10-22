import { type Project, type Thread } from "../types";
import {
  enumerateCommandPaletteItems,
  buildBrowseGroups,
  buildCommandPaletteProjectMetadata,
  buildCommandPaletteRows,
  buildProjectActionItems,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
  type CommandPaletteUiState,
} from "./CommandPalette.logic";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  resolveProjectEnvironmentSummary,
} from "../sidebarProjectGrouping";

describe("linked pull request thread navigation", () => {
  it("keeps archived relations searchable and routes them through the PR environment", async () => {
    const environmentId = EnvironmentId.make("remote");
    const id = ThreadId.make("archived-thread");
    const runThread = vi.fn(async () => {});
    const query = "https://github.com/acme/web/pull/42";
    const linkedThreads = {
      environmentId,
      threads: [
        {
          id,
          projectId: ProjectId.make("project"),
          title: "Completed work",
          archivedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    };
    const state = reduceCommandPaletteUiState(
      { open: false, mode: "command", openIntent: null },
      {
        _tag: "OpenSearch",
        query,
        linkedThreads,
      },
    );
    expect(state.openIntent).toEqual({ kind: "search", query, linkedThreads });
    const items = buildLinkedThreadActionItems({ ...linkedThreads, query, icon: null, runThread });
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query,
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });
    expect(groups.flatMap((group) => group.items)).toEqual(items);
    expect(items[0]?.description).toBe("Archived thread");
    await items[0]?.run();
    expect(runThread).toHaveBeenCalledWith({ environmentId, id });
  });
});

describe("reduceCommandPaletteUiState", () => {
  it("opens PR search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null },
      {
        _tag: "OpenSearch",
        query: "https://github.com/acme/web/pull/7",
      },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "https://github.com/acme/web/pull/7" },
    });
    const second = reduceCommandPaletteUiState(first, {
      _tag: "OpenSearch",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(second.openIntent).toEqual({
      kind: "search",
      query: "https://github.com/acme/web/pull/8",
    });
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("carries the environment a project should be added to", () => {
    expect(
      reduceCommandPaletteUiState(closedState, {
        _tag: "OpenAddProject",
        environmentId: "remote",
      }),
    ).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project", environmentId: "remote" },
    });
    // No environment means "ask", and the key has to be absent rather than
    // undefined for the flow to tell the two apart.
    expect(
      reduceCommandPaletteUiState(closedState, { _tag: "OpenAddProject" }).openIntent,
    ).not.toHaveProperty("environmentId");
  });

  it("preserves the mode on close and resets it on open", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const closedState = { open: false, mode: "command", openIntent: null } as const;

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("buildProjectActionItems", () => {
  it.each(["project", "new-thread-in"])(
    "keeps linked projects together and searchable from every environment in %s",
    async (valuePrefix) => {
      const remoteEnvironmentId = EnvironmentId.make("home-lab");
      const local = makeProject({ title: "Junti", linkKey: "link:junti" });
      const remote = makeProject({
        id: ProjectId.make("junti-remote"),
        environmentId: remoteEnvironmentId,
        title: "Junti server",
        workspaceRoot: "/srv/junti",
        linkKey: "link:junti",
      });
      const locations = new Map([
        [LOCAL_ENVIRONMENT_ID, { label: "Local" }],
        [remoteEnvironmentId, { label: "Home Lab" }],
      ]);
      const groups = buildSidebarProjectSnapshots({
        projects: [local, remote],
        settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
        primaryEnvironmentId: LOCAL_ENVIRONMENT_ID,
        resolveEnvironmentLabel: (id) => locations.get(id)?.label ?? null,
      });
      const entries = buildSidebarProjectPickerEntries({
        groups,
        preferredProjectRef: { environmentId: remoteEnvironmentId, projectId: remote.id },
      });
      const runProject = vi.fn(async () => undefined);
      const items = entries.flatMap(({ group, targetProject }) =>
        buildProjectActionItems({
          projects: [{ ...targetProject, displayName: group.displayName }],
          valuePrefix,
          searchTerms: () =>
            buildCommandPaletteProjectMetadata({
              projects: group.memberProjects,
              locationByEnvironmentId: locations,
            }).searchTerms,
          icon: () => null,
          runProject,
        }),
      );

      expect(items).toHaveLength(1);
      expect(resolveProjectEnvironmentSummary(groups[0]!, LOCAL_ENVIRONMENT_ID)).toMatchObject({
        label: "2 envs",
        description: "Available in 2 environments: Local, Home Lab",
      });
      for (const query of ["local", "home lab", "/srv/junti", "/workspace/project"]) {
        const filtered = filterCommandPaletteGroups({
          activeGroups: [{ value: "projects", label: "Projects", items }],
          isInSubmenu: true,
          query,
          projectSearchItems: [],
          threadSearchItems: [],
        });
        expect(filtered.flatMap((group) => group.items)).toEqual(items);
      }
      await items[0]!.run();
      expect(runProject).toHaveBeenCalledWith(
        expect.objectContaining({ id: remote.id, environmentId: remoteEnvironmentId }),
      );
    },
  );

  it("shows the grouped display name but keeps the real title for icons", () => {
    const project = makeProject({ title: "fleet", workspaceRoot: "/Users/theo/Code/p/fleet" });
    const iconTitles: string[] = [];
    const [item] = buildProjectActionItems({
      projects: [{ ...project, displayName: "t3dotgg/fleet" }],
      valuePrefix: "project",
      icon: (candidate) => {
        iconTitles.push(candidate.title);
        return null;
      },
      runProject: async () => undefined,
    });

    expect(item?.title).toBe("t3dotgg/fleet");
    expect(item?.searchTerms).toEqual(
      expect.arrayContaining(["t3dotgg/fleet", "fleet", "/Users/theo/Code/p/fleet"]),
    );
    expect(iconTitles).toEqual(["fleet"]);
  });
});

describe("buildThreadActionItems", () => {
  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("orders title matches by recent activity before older prefix matches", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old-prefix"),
        title: "Convex InvalidCursor in Convex threads query",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-title"),
        title: "Disable Convex schema validation",
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-content"),
        title: "Fix schema validation",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "created_at",
      icon: null,
      getContentMatch: (thread) =>
        thread.id === ThreadId.make("recent-content")
          ? { source: "user", snippet: "Please check Convex", query: "convex" }
          : undefined,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "convex",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:recent-title",
      "thread:old-prefix",
      "thread:recent-content",
    ]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "GIT",
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:version-control",
            title: "Version control",
            searchTerms: ["git"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:version-control",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectTitleById: new Map([[PROJECT_ID, "T3 Code"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      projectSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${idThread.id}` }),
    ]);
  });
});

describe("filterPinnedBrowseEntries", () => {
  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});

it("keeps the clone destination environment and URL when entering from the repository catalog", () => {
  const state = reduceCommandPaletteUiState(
    { open: false, mode: "command", openIntent: null },
    {
      _tag: "OpenAddProject",
      environmentId: "remote-node",
      projectSource: "url",
      repositoryUrl: "git@example.test:team/repo.git",
    },
  );
  expect(state.openIntent).toEqual({
    kind: "add-project",
    environmentId: "remote-node",
    projectSource: "url",
    repositoryUrl: "git@example.test:team/repo.git",
  });
  expect(reduceCommandPaletteUiState(state, { _tag: "ClearOpenIntent" }).openIntent).toBeNull();
  expect(
    reduceCommandPaletteUiState(state, {
      _tag: "OpenAddProject",
      environmentId: "local",
      projectSource: "local",
    }).openIntent,
  ).toEqual({ kind: "add-project", environmentId: "local", projectSource: "local" });
});

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectTitleById: new Map(),
    sortOrder: "updated_at",
    icon: null,
    runThread: async () => undefined,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
  expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
    "Implementation",
  ]);
});

describe("command palette search return", () => {
  const picker = { addonIcon: null, groups: [] };

  it("restores each parent query when backing out of nested pickers", () => {
    let state = createCommandPaletteSearchState(">new thread");
    state = reduceCommandPaletteSearchState(state, { type: "push", view: picker });
    expect(state.query).toBe("");
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "remote project" });
    state = reduceCommandPaletteSearchState(state, {
      type: "push",
      view: { ...picker, initialQuery: "~/" },
    });
    expect(state.query).toBe("~/");

    state = reduceCommandPaletteSearchState(state, { type: "query", query: "" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("remote project");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe(">new thread");
    expect(state.views).toHaveLength(0);
  });

  it("cannot return to an old picker after a new search replaces it", () => {
    let state = reduceCommandPaletteSearchState(createCommandPaletteSearchState("old"), {
      type: "push",
      view: picker,
    });
    state = reduceCommandPaletteSearchState(state, { type: "reset", query: "fresh" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("fresh");
    expect(state.views).toHaveLength(0);
  });
});

describe("returning from file and content search", () => {
  const root: CommandPaletteUiState = { open: true, mode: "command", openIntent: null };
  const query = "https://github.com/acme/web/pull/7";
  const context = {
    query,
    linkedThreadSearch: {
      kind: "search" as const,
      query,
      linkedThreads: {
        environmentId: EnvironmentId.make("remote"),
        threads: [
          {
            id: ThreadId.make("linked-thread"),
            projectId: ProjectId.make("project"),
            title: "Completed work",
            archivedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  it.each(["files", "content"] as const)(
    "Escape from %s restores the query and linked-thread results",
    (mode) => {
      const child = reduceCommandPaletteUiState(root, { _tag: "OpenChildSearch", mode, context });
      expect(child.mode).toBe(mode);
      const returned = reduceCommandPaletteUiState(child, { _tag: "BackToCommand" });
      expect(returned).toEqual({ ...root, restoredSearch: context });
      expect(reduceCommandPaletteUiState(returned, { _tag: "BackToCommand" })).toEqual(returned);
    },
  );

  it("closing a child search discards its return context before reopening", () => {
    const child: CommandPaletteUiState = { ...root, mode: "files", parentSearch: context };
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed).toEqual({ open: false, mode: "files", openIntent: null });
    expect(reduceCommandPaletteUiState(closed, { _tag: "BackToCommand" })).toEqual(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual(root);
  });
});
