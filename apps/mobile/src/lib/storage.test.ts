import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  let preferencesJson: string | null = null;
  let preferencesUpdatedAt = 0;
  let loadPreferencesFails = false;
  let savePreferencesFails = false;
  return {
    clear: () => {
      values.clear();
      preferencesJson = null;
      preferencesUpdatedAt = 0;
      loadPreferencesFails = false;
      savePreferencesFails = false;
    },
    getStoredValue: (key: string) => values.get(key) ?? null,
    getPreferencesJson: () => preferencesJson,
    setPreferencesJson: (value: string, updatedAt: number) => {
      preferencesJson = value;
      preferencesUpdatedAt = updatedAt;
    },
    setDatabaseFailures: (load: boolean, save: boolean) => {
      loadPreferencesFails = load;
      savePreferencesFails = save;
    },
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    database: {
      closeAsync: vi.fn(() => Promise.resolve()),
      execAsync: vi.fn(() => Promise.resolve()),
      withExclusiveTransactionAsync: vi.fn(
        (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
          run({ execAsync: () => Promise.resolve() }),
      ),
      getFirstAsync: vi.fn((sql: string) => {
        if (sql.includes("PRAGMA user_version")) {
          return Promise.resolve({ user_version: 1 });
        }
        if (loadPreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        return Promise.resolve(
          preferencesJson === null
            ? null
            : { payload: preferencesJson, updatedAt: preferencesUpdatedAt },
        );
      }),
      runAsync: vi.fn((_sql: string, payload?: unknown, updatedAt?: unknown) => {
        if (savePreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        if (typeof payload === "string") {
          preferencesJson = payload;
        }
        if (typeof updatedAt === "number") {
          preferencesUpdatedAt = updatedAt;
        }
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => null,
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(() => Promise.resolve(mocks.database)),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
  Platform: {
    OS: "ios",
  },
}));

import { loadPreferences, savePreferencesPatch } from "../persistence/imperative";

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists tab order locally and retains it when another preference changes", async () => {
    const navigationTabOrder = ["usage", "threads", "pullRequests"];
    const hiddenNavigationTabs = ["issues", "home"];
    await savePreferencesPatch({ navigationTabOrder, hiddenNavigationTabs });
    await savePreferencesPatch({ baseFontSize: 19 });
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder,
      hiddenNavigationTabs,
      baseFontSize: 19,
    });
  });

  it("ignores invalid tab-order entries without dropping other saved preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        navigationTabOrder: ["usage", null, 4, "threads"],
        hiddenNavigationTabs: ["home", null],
        baseFontSize: 18,
      }),
      1,
    );
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder: ["usage", "threads"],
      hiddenNavigationTabs: ["home"],
      baseFontSize: 18,
    });
  });

  it("loads legacy preferences when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 17 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("falls back to secure storage when SQLite cannot save preferences", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ baseFontSize: 19 })).resolves.toEqual({ baseFontSize: 19 });
    const fallback = JSON.parse(mocks.getStoredValue("t3code.preferences.fallback") ?? "") as {
      readonly payload: string;
      readonly updatedAt: number;
    };
    expect(JSON.parse(fallback.payload)).toEqual({ baseFontSize: 19 });
    expect(fallback.updatedAt).toEqual(expect.any(Number));
  });

  it("persists thread list shelf preferences", async () => {
    await expect(
      savePreferencesPatch({
        threadListSettledShelfExpanded: false,
        threadListSnoozedShelfExpanded: true,
        threadListWorkingShelfExpanded: true,
        workingShelfEnabled: true,
      }),
    ).resolves.toEqual({
      threadListSettledShelfExpanded: false,
      threadListSnoozedShelfExpanded: true,
      threadListWorkingShelfExpanded: true,
      workingShelfEnabled: true,
    });

    await expect(loadPreferences()).resolves.toEqual({
      threadListSettledShelfExpanded: false,
      threadListSnoozedShelfExpanded: true,
      threadListWorkingShelfExpanded: true,
      workingShelfEnabled: true,
    });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({
      threadListSettledShelfExpanded: false,
      threadListSnoozedShelfExpanded: true,
      threadListWorkingShelfExpanded: true,
      workingShelfEnabled: true,
    });
  });

  it("drops legacy and invalid thread list shelf expansion preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        baseFontSize: 17,
        threadListV2SettledShelfExpanded: true,
        threadListV2SnoozedShelfExpanded: true,
        threadListSettledShelfExpanded: "false",
        threadListSnoozedShelfExpanded: 1,
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("keeps the user's nested subagent show/hide choices and drops malformed ones", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        threadListNestedExpandedByKey: {
          "environment-1:parent-a": true,
          "environment-1:parent-b": false,
          "environment-1:parent-c": "yes",
        },
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({
      threadListNestedExpandedByKey: {
        "environment-1:parent-a": true,
        "environment-1:parent-b": false,
      },
    });
  });

  it("keeps valid list filters and drops malformed ones", async () => {
    const threadListFilters = { environmentId: "environment-1", projectKey: null };
    const pullRequestListFilters = {
      environmentId: null,
      controls: {
        "": {
          state: "all",
          involvement: "reviewing",
          filters: { labels: [["size:S"]] },
          sort: "oldest",
        },
      },
    };
    mocks.setPreferencesJson(JSON.stringify({ threadListFilters, pullRequestListFilters }), 10);
    await expect(loadPreferences()).resolves.toEqual({ threadListFilters, pullRequestListFilters });

    mocks.setPreferencesJson(
      JSON.stringify({
        threadListFilters: { environmentId: 1, projectKey: null },
        pullRequestListFilters: { environmentId: null, controls: { "": { sort: "newest" } } },
      }),
      11,
    );
    await expect(loadPreferences()).resolves.toEqual({});
  });

  it("reconciles fallback preferences after SQLite recovers", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 15 }), 10);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 19 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 19 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("ignores a stale fallback when its previous deletion failed", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("keeps SQLite authoritative when stale legacy preferences remain", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 19 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
  });
});
