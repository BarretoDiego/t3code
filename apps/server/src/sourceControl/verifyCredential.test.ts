import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { verifySourceControlCredential } from "./verifyCredential.ts";

it.effect("verifies GitHub identity at the fixed endpoint without forwarding redirects", () =>
  Effect.gen(function* () {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ login: "developer" }));
    expect(
      yield* verifySourceControlCredential(
        { provider: "github", label: "Work", username: "", workspace: "" },
        "fixture-secret",
        request,
      ),
    ).toEqual({ accountName: "developer" });
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer fixture-secret" }),
      }),
    );
  }),
);
it.effect("uses Atlassian email and token for Bitbucket API token authentication", () =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ display_name: "Developer" }));
    expect(
      yield* verifySourceControlCredential(
        { provider: "bitbucket", label: "Work", username: "dev@example.test", workspace: "" },
        "fixture-secret",
        request,
      ),
    ).toEqual({ accountName: "Developer" });
    expect(request).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/user",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("dev@example.test:fixture-secret").toString("base64")}`,
        }),
      }),
    );
  }),
);
it.effect("sanitizes denied, malformed and failed identity checks", () =>
  Effect.gen(function* () {
    for (const request of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture-secret", { status: 401 })),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "fixture-secret" })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error("Authorization fixture-secret")),
    ]) {
      const result = yield* verifySourceControlCredential(
        { provider: "github", label: "Work", username: "", workspace: "" },
        "fixture-secret",
        request,
      ).pipe(Effect.flip);
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).not.toContain("fixture-secret");
    }
  }),
);

it.effect(
  "verifies integration tokens through read-only repository access without user scopes",
  () =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ full_name: "team/repo" }));
      expect(
        yield* verifySourceControlCredential(
          {
            provider: "bitbucket",
            label: "Integration",
            username: "",
            workspace: "team",
            repository: "repo",
          },
          "fixture-secret",
          request,
        ),
      ).toEqual({ accountName: "team/repo" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "https://api.bitbucket.org/2.0/repositories/team/repo",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer fixture-secret" }),
        }),
      );
    }),
);
it.effect("verifies API tokens with repository scopes when user-profile access is denied", () =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ values: [] }));
    expect(
      yield* verifySourceControlCredential(
        { provider: "bitbucket", label: "Work", username: "dev@example.test", workspace: "team" },
        "fixture-secret",
        request,
      ),
    ).toEqual({ accountName: "team" });
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "https://api.bitbucket.org/2.0/user",
      "https://api.bitbucket.org/2.0/repositories/team?pagelen=1",
    ]);
  }),
);
