import { expect, it } from "@effect/vitest";
import {
  AgentProfile,
  DEFAULT_SERVER_SETTINGS,
  MiniSkillId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { resolveAgentTaskConfiguration } from "./agentTaskConfiguration.ts";
const id = ProviderInstanceId.make("local-opencode");
const skillId = MiniSkillId.make("security");
const profile = Schema.decodeUnknownSync(AgentProfile)({
  id: "reviewer",
  slug: "reviewer",
  name: "PR Reviewer",
  description: "",
  enabled: true,
  instructions: "Inspect API contracts.",
  miniSkillIds: [skillId],
  routes: [{ id: "route", instanceId: id, modelCandidates: ["available-model"] }],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  agentProfiles: [profile],
  miniSkills: [
    {
      id: skillId,
      name: "Security",
      description: "",
      content: "Check authorization boundaries.",
      enabledByDefaultForNewThreads: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
};
const instance = {
  instanceId: id,
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({ models: [{ slug: "available-model" }] }) },
} as unknown as ProviderInstance;
const dependencies = Layer.mergeAll(
  Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
  Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(instance) }),
);
it.effect("resolves profile model routes and composes Mini Skills only for this task", () =>
  Effect.gen(function* () {
    const result = yield* resolveAgentTaskConfiguration({
      modelSelection: { instanceId: id, model: "old-model" },
      profileId: profile.id,
      miniSkillIds: [skillId],
    });
    expect(result.agent.modelSelection.model).toBe("available-model");
    expect(result.agent.miniSkillIds).toEqual([skillId]);
    const prompt = result.compose("Review the diff");
    expect(prompt).toContain("Inspect API contracts.");
    expect(prompt).toContain("Check authorization boundaries.");
    expect(prompt).toContain("Review the diff");
    expect(settings.miniSkills[0]?.enabledByDefaultForNewThreads).toBe(false);
  }).pipe(Effect.provide(dependencies)),
);
it.effect(
  "preserves the selected provider/model and plain prompt without a profile or skills",
  () =>
    Effect.gen(function* () {
      const selection = { instanceId: id, model: "available-model" };
      const result = yield* resolveAgentTaskConfiguration({
        modelSelection: selection,
        miniSkillIds: [],
      });
      expect(result.agent.modelSelection).toEqual(selection);
      expect(result.compose("Describe changes")).toBe("Describe changes");
    }).pipe(Effect.provide(dependencies)),
);

const effortInstance = {
  instanceId: id,
  enabled: true,
  snapshot: {
    getSnapshot: Effect.succeed({
      models: [
        {
          slug: "available-model",
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                type: "select",
                options: [{ id: "low" }, { id: "high" }],
              },
            ],
          },
        },
      ],
    }),
  },
} as unknown as ProviderInstance;
const effortDependencies = Layer.mergeAll(
  Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
  Layer.mock(ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(effortInstance) }),
);
it.effect("applies the default reasoning effort only when the model supports it", () =>
  Effect.gen(function* () {
    const applied = yield* resolveAgentTaskConfiguration(
      { modelSelection: { instanceId: id, model: "available-model" }, miniSkillIds: [] },
      { reasoningEffort: "high" },
    );
    expect(applied.agent.modelSelection.options).toEqual([
      { id: "reasoningEffort", value: "high" },
    ]);
    const unsupported = yield* resolveAgentTaskConfiguration(
      { modelSelection: { instanceId: id, model: "available-model" }, miniSkillIds: [] },
      { reasoningEffort: "ultra" },
    );
    expect(unsupported.agent.modelSelection.options).toBeUndefined();
  }).pipe(Effect.provide(effortDependencies)),
);
it.effect("keeps an explicit reasoning effort ahead of the default", () =>
  Effect.gen(function* () {
    const result = yield* resolveAgentTaskConfiguration(
      {
        modelSelection: {
          instanceId: id,
          model: "available-model",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        miniSkillIds: [],
      },
      { reasoningEffort: "high" },
    );
    expect(result.agent.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  }).pipe(Effect.provide(effortDependencies)),
);
