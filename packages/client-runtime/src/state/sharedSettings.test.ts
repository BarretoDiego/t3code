import {
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  splitSharedServerPatch,
  supportsSharedSettingsSync,
  filterSharedServerPatch,
  pickSharedServerSettings,
} from "./sharedSettings.ts";
import { describe, expect, it } from "@effect/vitest";

const restartCapabilities = { threadRestartContinuation: true };

describe("supportsSharedSettingsSync", () => {
  it("accepts only connected servers that advertise the shared-settings capability", () => {
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(true);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: {} } },
      }),
    ).toBe(false);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "reconnecting" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(false);
  });
});

describe("splitSharedServerPatch", () => {
  it("keeps project overrides local: project ids belong to one environment", () => {
    const patch = {
      projectSettingsOverrides: { [ProjectId.make("project")]: { defaultAutoPull: true } },
      sidebarAutoSettleOnMerge: false,
    };
    expect(splitSharedServerPatch(patch)).toEqual({
      sharedPatch: { sidebarAutoSettleOnMerge: false },
      localPatch: { projectSettingsOverrides: patch.projectSettingsOverrides },
    });
  });

  it.each([
    {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "high" }],
    },
    DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  ])("shares the text generation model and options, including reset (%j)", (selection) => {
    const patch = { textGenerationModelSelection: selection };
    expect(splitSharedServerPatch(patch)).toEqual({ sharedPatch: patch, localPatch: {} });
    expect(pickSharedServerSettings({ ...DEFAULT_SERVER_SETTINGS, ...patch })).toMatchObject(patch);
  });

  it("routes preference keys to the shared patch and machine keys to the local patch", () => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
      newWorktreesStartFromOrigin: true,
    });
    expect(sharedPatch).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      newWorktreesStartFromOrigin: true,
    });
    expect(localPatch).toEqual({
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
    });
  });
});

describe("pickSharedServerSettings", () => {
  it("returns only the shared keys", () => {
    expect(
      Object.keys(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, restartCapabilities)).sort(),
    ).toEqual([
      "agentProfileDefaultWrapper",
      "agentProfiles",
      "autoResumeLimitedThreads",
      "continueThreadsAfterServerUpdate",
      "miniSkillPromptWrappers",
      "miniSkills",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleAfterDays",
      "sidebarAutoSettleOnMerge",
      "snoozeLimitedThreads",
      "snoozePresets",
      "sourceControlReview",
      "sourceControlWritingStyle",
      "textGenerationModelSelection",
    ]);
  });
});

describe("filterSharedServerPatch", () => {
  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, undefined, settings, settings, targetIsSource)).toEqual(
        {
          ...(targetIsSource
            ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
            : {}),
          sidebarAutoSettleAfterDays: 7,
        },
      );
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, restartCapabilities, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );

  it.each([undefined, {}, { threadRestartContinuation: false }])(
    "omits only the unsupported restart preference with capabilities %j",
    (capabilities) => {
      expect(
        filterSharedServerPatch(
          { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 },
          capabilities,
        ),
      ).toEqual({ sidebarAutoSettleAfterDays: 7 });
      expect(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, capabilities)).not.toHaveProperty(
        "continueThreadsAfterServerUpdate",
      );
    },
  );
});
