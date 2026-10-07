import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type ExecutionNode, ExecutionNodeId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { formatNode, formatNodeLine, parseJobFile } from "./node.ts";

const node: ExecutionNode = {
  id: ExecutionNodeId.make("local"),
  environmentId: EnvironmentId.make("env-here"),
  label: "This machine",
  transport: { type: "local" },
  enabled: true,
  workspaceRoots: [],
  allowShell: false,
  availability: {
    status: "unknown",
    os: null,
    arch: null,
    tools: [],
    error: null,
    observedAt: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("node CLI", () => {
  it.effect("reads a job file without a node, and with or without an idempotency key", () =>
    Effect.gen(function* () {
      const job = yield* parseJobFile(
        '{"cwd": "/srv/app", "action": {"type": "command", "executable": "npm", "args": ["test"]}, "timeoutMs": 60000}',
      );
      assert.deepStrictEqual(job, {
        cwd: "/srv/app",
        action: { type: "command", executable: "npm", args: ["test"] },
        timeoutMs: 60000,
      });
      const keyed = yield* parseJobFile(
        '{"idempotencyKey": "nightly-1", "idempotent": true, "cwd": "/srv/app", "action": {"type": "shell", "script": "make"}}',
      );
      assert.strictEqual(keyed.idempotencyKey, "nightly-1");
      assert.isTrue(keyed.idempotent);
    }),
  );

  it.effect("refuses a job file it cannot read as a fixed command or a shell line", () =>
    Effect.gen(function* () {
      for (const text of [
        "",
        "npm test",
        '{"action": {"type": "command", "executable": "npm", "args": []}}',
        // A command is an executable and an argument list, not a string to be split.
        '{"cwd": "/srv/app", "action": {"type": "command", "executable": "npm test"}}',
        '{"cwd": "/srv/app", "action": {"type": "script", "script": "make"}}',
        '{"cwd": "/srv/app", "action": {"type": "shell", "script": "make"}, "timeoutMs": 0}',
      ]) {
        const error = yield* parseJobFile(text).pipe(Effect.flip);
        assert.include(error.message, "job file must be JSON", text);
      }
    }),
  );

  it("shows that a node without workspace roots runs nothing, and a probe with its time", () => {
    assert.include(formatNode(node), "none - no job can run here yet");
    assert.include(formatNode(node), "shell:      not allowed");
    assert.include(formatNodeLine(node), "not probed");
    const probed: ExecutionNode = {
      ...node,
      id: ExecutionNodeId.make("node-build"),
      label: "Build box",
      transport: { type: "ssh", target: "dev@build", port: 2222 },
      availability: {
        status: "unavailable",
        os: null,
        arch: null,
        tools: [],
        error: "SSH command timed out after 30000ms.",
        observedAt: "2026-01-02T03:04:05.000Z",
      },
    };
    const line = formatNodeLine(probed);
    assert.include(line, "ssh dev@build:2222");
    assert.include(line, "unavailable as of 2026-01-02T03:04:05.000Z (SSH command timed out");
  });
});
