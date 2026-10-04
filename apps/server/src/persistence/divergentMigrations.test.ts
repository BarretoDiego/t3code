import { assert, describe, it } from "@effect/vitest";

import { divergentMigrations } from "./Migrations.ts";

const manifest = [
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [54, "ProjectionThreadMessageContext"],
] as const;

describe("migration history check", () => {
  it("accepts the fork history that later migrations reconcile", () => {
    assert.deepStrictEqual(
      divergentMigrations(
        [
          { migration_id: 47, name: "ProjectionProjectIcon" },
          { migration_id: 48, name: "ProjectionThreadsMiniSkills" },
          { migration_id: 54, name: "ReconcileProjectionThreadFeatures" },
        ],
        manifest,
      ),
      [],
    );
  });

  it("still reports a skipped migration nothing makes up for", () => {
    assert.deepStrictEqual(
      divergentMigrations(
        [
          { migration_id: 47, name: "SomethingElse" },
          // A reconciled name only excuses the id it was recorded under.
          { migration_id: 54, name: "ProjectionThreadsMiniSkills" },
          { migration_id: 99, name: "FromANewerBuild" },
        ],
        manifest,
      ),
      [
        "47:SomethingElse (this build: ProjectionProjectIcon)",
        "54:ProjectionThreadsMiniSkills (this build: ProjectionThreadMessageContext)",
        "99:FromANewerBuild (unknown to this build)",
      ],
    );
  });
});
