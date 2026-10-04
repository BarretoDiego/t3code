// @effect-diagnostics nodeBuiltinImport:off -- Runs the real CLI in a separate process to verify stdout, stderr and exit codes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

function runStatus(...args: string[]) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-status-cli-"));
  try {
    return NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        "status",
        "--base-dir",
        home,
        ...args,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
}

describe("status CLI output", () => {
  it("prints valid JSON and reports an unavailable server as unknown", () => {
    const result = runStatus("--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      safeToClose: false,
      environments: [{ readiness: "unknown" }],
    });
  }, 30_000);
  it("returns a non-zero check with valid JSON, keeping diagnostics on stderr", () => {
    const result = runStatus("--check", "--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ safeToClose: false });
    expect(result.stderr).toContain("Inspect the report before closing");
  }, 30_000);
  it("rejects a tight watch loop before opening a connection", () => {
    const result = runStatus("--watch", "0ms");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least 1s");
  }, 30_000);
});
