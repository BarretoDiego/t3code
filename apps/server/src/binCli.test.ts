// @effect-diagnostics nodeBuiltinImport:off -- Exercises the CLI's real stdout and stderr through a subprocess.
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./persistence/Migrations.ts";

// Opening a database that a newer T3 Code migrated logs a warning while the CLI
// mints its local session. With --json that warning must not reach the output.
// No server runs for this base dir, so the command ends in its JSON error.
it.live("keeps migration warnings out of JSON thread output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-json-" });
    const stateDir = `${root}/userdata`;
    yield* fs.makeDirectory(stateDir);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const futureId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${futureId}, 'FutureMigration')
      `;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${stateDir}/statev2.sqlite` })));

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
          "thread",
          "list",
          "--json",
          "--base-dir",
          root,
        ],
        { env: { T3CODE_HOME: root } },
      ),
    );
    const { stdout, stderr, exitCode } = yield* Effect.all(
      {
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        exitCode: child.exitCode,
      },
      { concurrency: "unbounded" },
    );
    assert.notStrictEqual(Number(exitCode), 0);
    assert.strictEqual(stdout, "");
    const lines = stderr.split("\n").filter((line) => line.trim().length > 0);
    assert.strictEqual(lines.length, 1, stderr);
    const output: { readonly error?: { readonly code?: unknown } } = JSON.parse(lines[0]!);
    assert.isString(output.error?.code);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
