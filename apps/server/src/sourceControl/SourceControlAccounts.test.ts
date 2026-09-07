import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import { ProjectId } from "@t3tools/contracts";
import { make } from "./SourceControlAccounts.ts";

const dependencies = Secrets.layer.pipe(
  Layer.provideMerge(
    Config.layerTest(process.cwd(), { prefix: "t3-source-control-accounts-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
it.effect(
  "persists accounts without returning secrets, preserves omitted tokens, and removes credentials",
  () =>
    Effect.gen(function* () {
      const accounts = yield* make;
      const account = {
        provider: "bitbucket" as const,
        label: "Work",
        username: "dev@example.test",
        workspace: "team",
      };
      yield* accounts.save({ account, token: "private-fixture-token" });
      const restarted = yield* make;
      expect(yield* restarted.list).toEqual([{ ...account, hasCredential: true }]);
      expect(Object.keys((yield* restarted.list)[0] ?? {})).not.toContain("token");
      yield* restarted.save({ account: { ...account, label: "Renamed" } });
      expect((yield* accounts.credential("bitbucket"))?.token).toBe("private-fixture-token");
      yield* restarted.save({ account, token: "" });
      expect((yield* accounts.list)[0]?.hasCredential).toBe(false);
      yield* restarted.remove("bitbucket");
      expect(yield* accounts.list).toEqual([]);
      expect(yield* accounts.credential("bitbucket")).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect(
  "persists manual repository mappings without duplicating a project remote and restores automatic mapping",
  () =>
    Effect.gen(function* () {
      const accounts = yield* make;
      const mapping = {
        projectId: ProjectId.make("mapping-project"),
        remoteName: "origin",
        reference: { provider: "github" as const, host: "github.com", repository: "owner/repo" },
      };
      yield* accounts.saveMapping(mapping);
      yield* accounts.saveMapping({
        ...mapping,
        reference: { ...mapping.reference, repository: "owner/renamed" },
      });
      const restarted = yield* make;
      expect(yield* restarted.mappings).toEqual([
        { ...mapping, reference: { ...mapping.reference, repository: "owner/renamed" } },
      ]);
      yield* restarted.saveMapping({ ...mapping, reference: null });
      expect(yield* accounts.mappings).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("only replaces saved credentials after successful provider verification", () =>
  Effect.gen(function* () {
    const accounts = yield* make;
    const account = { provider: "github" as const, label: "Work", username: "", workspace: "" };
    yield* accounts.save({ account, token: "previous-token" });
    const originalFetch = globalThis.fetch;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        globalThis.fetch = originalFetch;
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 401 })),
    );
    yield* accounts.connect({ account, token: "invalid-token" }).pipe(Effect.flip);
    expect((yield* accounts.credential("github"))?.token).toBe("previous-token");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ login: "developer" })),
    );
    expect(yield* accounts.connect({ account, token: "new-token" })).toEqual({
      accountName: "developer",
    });
    expect((yield* accounts.credential("github"))?.token).toBe("new-token");
    expect((yield* accounts.list)[0]).not.toHaveProperty("token");
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);
