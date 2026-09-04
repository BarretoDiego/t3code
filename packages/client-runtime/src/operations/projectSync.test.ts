import type { ProjectSyncManifestEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  batchProjectSyncEntries,
  computeProjectSyncPlan,
  summarizeProjectSyncPlan,
} from "./projectSync.ts";

function file(
  path: string,
  overrides: Partial<ProjectSyncManifestEntry> = {},
): ProjectSyncManifestEntry {
  return {
    path,
    kind: "file",
    size: 10,
    hash: "a".repeat(64),
    ...overrides,
  };
}

function dir(path: string): ProjectSyncManifestEntry {
  return { path, kind: "dir", size: 0 };
}

function symlink(path: string, linkTarget: string): ProjectSyncManifestEntry {
  return { path, kind: "symlink", size: 0, linkTarget };
}

describe("computeProjectSyncPlan", () => {
  it("copies entries missing from the destination", () => {
    const plan = computeProjectSyncPlan([file("a.txt"), file("b.txt")], [file("a.txt")]);

    expect(plan.toCopy.map((entry) => entry.path)).toEqual(["b.txt"]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.copyBytes).toBe(10);
  });

  it("copies files whose hash differs even when size and mode match", () => {
    const source = [file("a.txt", { hash: "b".repeat(64), size: 10, mode: 0o644 })];
    const dest = [file("a.txt", { hash: "a".repeat(64), size: 10, mode: 0o644 })];

    expect(computeProjectSyncPlan(source, dest).toCopy.map((entry) => entry.path)).toEqual([
      "a.txt",
    ]);
  });

  it("copies files whose size differs even when hash matches", () => {
    const hash = "a".repeat(64);
    const source = [file("a.txt", { hash, size: 20 })];
    const dest = [file("a.txt", { hash, size: 10 })];

    expect(computeProjectSyncPlan(source, dest).toCopy.map((entry) => entry.path)).toEqual([
      "a.txt",
    ]);
  });

  it("copies files whose mode differs even when hash and size match", () => {
    const hash = "a".repeat(64);
    const source = [file("a.txt", { hash, size: 10, mode: 0o755 })];
    const dest = [file("a.txt", { hash, size: 10, mode: 0o644 })];

    expect(computeProjectSyncPlan(source, dest).toCopy.map((entry) => entry.path)).toEqual([
      "a.txt",
    ]);
  });

  it("does not copy an unchanged file", () => {
    const hash = "a".repeat(64);
    const source = [file("a.txt", { hash, size: 10, mode: 0o644 })];
    const dest = [file("a.txt", { hash, size: 10, mode: 0o644 })];

    expect(computeProjectSyncPlan(source, dest).toCopy).toEqual([]);
  });

  it("copies when kind changes between source and destination", () => {
    const source = [symlink("link", "target-a")];
    const dest = [file("link")];

    expect(computeProjectSyncPlan(source, dest).toCopy.map((entry) => entry.path)).toEqual([
      "link",
    ]);
  });

  it("copies symlinks whose target differs", () => {
    const source = [symlink("link", "target-a")];
    const dest = [symlink("link", "target-b")];

    expect(computeProjectSyncPlan(source, dest).toCopy.map((entry) => entry.path)).toEqual([
      "link",
    ]);
  });

  it("does not copy an unchanged symlink", () => {
    const source = [symlink("link", "target-a")];
    const dest = [symlink("link", "target-a")];

    expect(computeProjectSyncPlan(source, dest).toCopy).toEqual([]);
  });

  it("copies an empty directory only when it is missing from the destination", () => {
    const source = [dir("empty")];

    expect(computeProjectSyncPlan(source, []).toCopy.map((entry) => entry.path)).toEqual(["empty"]);
    expect(computeProjectSyncPlan(source, [dir("empty")]).toCopy).toEqual([]);
  });

  it("deletes destination-only entries, deepest paths first", () => {
    const dest = [
      file("a.txt"),
      file("dir/nested/deep.txt"),
      file("dir/shallow.txt"),
      dir("empty"),
    ];

    const plan = computeProjectSyncPlan([], dest);

    expect(plan.toDelete).toEqual(["dir/nested/deep.txt", "dir/shallow.txt", "a.txt", "empty"]);
  });

  it("leaves entries present on both sides out of the deletion list", () => {
    const source = [file("keep.txt")];
    const dest = [file("keep.txt"), file("remove.txt")];

    expect(computeProjectSyncPlan(source, dest).toDelete).toEqual(["remove.txt"]);
  });

  it("sums copyBytes across every entry marked for copy", () => {
    const plan = computeProjectSyncPlan(
      [file("a.txt", { size: 100 }), file("b.txt", { size: 250 }), dir("empty")],
      [],
    );

    expect(plan.copyBytes).toBe(350);
  });
});

describe("batchProjectSyncEntries", () => {
  it("groups entries under both the byte and file ceilings", () => {
    const entries = [
      file("a.txt", { size: 10 }),
      file("b.txt", { size: 10 }),
      file("c.txt", { size: 10 }),
    ];

    const batches = batchProjectSyncEntries(entries, { maxBytes: 25, maxFiles: 500 });

    expect(batches).toEqual([[entries[0], entries[1]], [entries[2]]]);
  });

  it("splits on the file-count ceiling even when bytes have headroom", () => {
    const entries = [
      file("a.txt", { size: 1 }),
      file("b.txt", { size: 1 }),
      file("c.txt", { size: 1 }),
    ];

    const batches = batchProjectSyncEntries(entries, { maxBytes: 1024, maxFiles: 2 });

    expect(batches).toEqual([[entries[0], entries[1]], [entries[2]]]);
  });

  it("gives an entry larger than maxBytes its own batch instead of dropping or splitting it", () => {
    const entries = [
      file("small.txt", { size: 10 }),
      file("huge.bin", { size: 1000 }),
      file("also-small.txt", { size: 10 }),
    ];

    const batches = batchProjectSyncEntries(entries, { maxBytes: 100, maxFiles: 500 });

    expect(batches).toEqual([[entries[0]], [entries[1]], [entries[2]]]);
  });

  it("returns no batches for an empty entry list", () => {
    expect(batchProjectSyncEntries([])).toEqual([]);
  });

  it("uses sane defaults when no options are given", () => {
    const entries = [file("a.txt", { size: 10 }), file("b.txt", { size: 10 })];

    expect(batchProjectSyncEntries(entries)).toEqual([entries]);
  });
});

describe("summarizeProjectSyncPlan", () => {
  it("reports copy/delete counts and total copy bytes", () => {
    const plan = computeProjectSyncPlan(
      [file("a.txt", { size: 30 }), file("b.txt", { size: 20 })],
      [file("b.txt", { size: 20 }), file("stale.txt")],
    );

    expect(summarizeProjectSyncPlan(plan)).toEqual({
      copyCount: 1,
      deleteCount: 1,
      copyBytes: 30,
    });
  });
});
