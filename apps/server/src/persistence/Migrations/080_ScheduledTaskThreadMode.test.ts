import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import migration from "./080_ScheduledTaskThreadMode.ts";

it.effect("preserves scheduled tasks and continues only tasks already bound to a thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, thread_id TEXT, prompt TEXT)`;
    yield* sql`INSERT INTO scheduled_tasks (id, thread_id, prompt) VALUES
      ('bound', 'thread-1', 'Keep working'), ('unbound', NULL, 'Start work')`;
    yield* migration;
    assert.deepStrictEqual(
      yield* sql`SELECT id, thread_id, prompt, thread_mode FROM scheduled_tasks ORDER BY id`,
      [
        { id: "bound", thread_id: "thread-1", prompt: "Keep working", thread_mode: "continue" },
        { id: "unbound", thread_id: null, prompt: "Start work", thread_mode: "new_thread" },
      ],
    );
    yield* sql`INSERT INTO scheduled_tasks (id, prompt) VALUES ('new', 'New work')`;
    assert.deepStrictEqual(yield* sql`SELECT thread_mode FROM scheduled_tasks WHERE id = 'new'`, [
      { thread_mode: "new_thread" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
