// @effect-diagnostics nodeBuiltinImport:off -- Run the CLI separately to verify its public stdout and exit code without a server.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { describe, expect, it } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import { buildCommandCatalog } from "./commandCatalog.ts";
import { AGENT_GUIDE, GUIDE_TOPIC_IDS, guideTopicText } from "./guide.ts";

const runGuide = (...args: string[]) =>
  NodeChildProcess.spawnSync(
    process.execPath,
    [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "guide", ...args],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, T3CODE_ENV: "missing-guide-env" } },
  );

describe("t3 guide", () => {
  it("prints a complete JSON catalog without resolving an environment", () => {
    const result = runGuide("--json");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const guide = JSON.parse(result.stdout);
    expect(guide).toMatchObject({
      schemaVersion: 1,
      version: expect.any(String),
      guide: AGENT_GUIDE,
    });
    expect(guide.commands).toEqual(buildCommandCatalog(makeCli()));
    expect(guide.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["t3"], arguments: expect.any(Array) }),
        expect.objectContaining({ path: ["t3", "auth", "session", "issue"] }),
        expect.objectContaining({ path: ["t3", "__ssh-helper", "wait-ready"] }),
        expect.objectContaining({ path: ["t3", "fork", "install-pending"], unlisted: true }),
        expect.objectContaining({
          path: ["t3", "thread", "new"],
          flags: expect.arrayContaining([
            expect.objectContaining({
              flag: "--runtime-mode",
              choices: expect.arrayContaining(["full-access"]),
            }),
            expect.objectContaining({ flag: "--mode", choices: ["default", "plan"] }),
            expect.objectContaining({ flag: "--skill", variadic: true, minOccurrences: 0 }),
            expect.objectContaining({ flag: "--help", aliases: ["-h"], source: "global" }),
            expect.objectContaining({
              flag: "--completions",
              choices: ["bash", "zsh", "fish", "sh"],
            }),
          ]),
        }),
        expect.objectContaining({
          path: ["t3", "guide"],
          flags: expect.arrayContaining([
            expect.objectContaining({ flag: "--json", required: false }),
          ]),
        }),
      ]),
    );
  }, 30_000);

  it("still prints the operating manual by default", () => {
    const result = runGuide();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(AGENT_GUIDE.trim());
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("command catalog metadata", () => {
  it("includes hidden flags, inherited options, aliases and bounded positional arguments without executing handlers", () => {
    const child = Command.make("child", {
      secret: Flag.String("secret").pipe(Flag.withHidden, Flag.optional),
      files: Argument.String("files").pipe(Argument.between(1, 3)),
    }).pipe(
      Command.withAlias("c"),
      Command.unlisted,
      Command.withHandler(() => Effect.die("must not run")),
    );
    const root = Command.make("fixture").pipe(
      Command.withSharedFlags({
        workspace: Flag.String("workspace").pipe(Flag.withAlias("w")),
        verbose: Flag.Boolean("verbose"),
      }),
      Command.withSubcommands([child]),
    );
    const catalog = buildCommandCatalog(root);
    expect(catalog[1]).toMatchObject({
      path: ["fixture", "child"],
      alias: "c",
      unlisted: true,
      arguments: [
        { name: "files", required: true, variadic: true, minOccurrences: 1, maxOccurrences: 3 },
      ],
      flags: expect.arrayContaining([
        expect.objectContaining({ name: "secret", hidden: true, required: false }),
        expect.objectContaining({ name: "verbose", source: "inherited", required: false }),
        expect.objectContaining({ name: "workspace", source: "inherited", required: true }),
      ]),
    });
    expect(catalog[1]?.flags.filter((flag) => flag.name === "workspace")).toHaveLength(1);
    expect(catalog[0]?.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "workspace", aliases: ["-w"], required: true }),
      ]),
    );
  });

  it("reflects the commands available in each build", () => {
    const enabled = buildCommandCatalog(makeCli({ cloudEnabled: true }));
    const disabled = buildCommandCatalog(makeCli({ cloudEnabled: false }));
    expect(enabled.some((command) => command.path.join(" ") === "t3 connect login")).toBe(true);
    expect(disabled.some((command) => command.path.join(" ") === "t3 connect login")).toBe(false);
    expect(disabled.find((command) => command.path.join(" ") === "t3 connect")).toMatchObject({
      unlisted: true,
      description: expect.stringContaining("unavailable"),
    });
  });

  it("lists its topics, and every topic has text in the guide", () => {
    const result = runGuide("--topics");
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(GUIDE_TOPIC_IDS);
    for (const id of GUIDE_TOPIC_IDS) {
      const text = guideTopicText(id);
      expect(text, id).toBeDefined();
      expect(AGENT_GUIDE).toContain(text);
    }
  });

  it("prints one topic with only that topic's commands", () => {
    const result = runGuide("--topic", "hooks", "--json");
    expect(result.status).toBe(0);
    const guide = JSON.parse(result.stdout);
    expect(guide.topic).toBe("hooks");
    expect(guide.guide.startsWith("## Hooks")).toBe(true);
    expect(guide.guide).not.toContain("## Orchestrators");
    expect(guide.commands.length).toBeGreaterThan(0);
    expect(guide.commands.every((entry: { path: string[] }) => entry.path[1] === "hooks")).toBe(
      true,
    );
  });

  it("keeps the whole thread section together under one topic", () => {
    const text = guideTopicText("threads");
    expect(text).toContain("## Core loop");
    expect(text).toContain("## Approvals and questions");
    expect(text).toContain("## Controlling and organizing");
    expect(text).not.toContain("## Mini skills");
  });

  it("prints a compact listing of runnable commands", () => {
    const result = runGuide("--topic", "jobs", "--compact");
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((line) => line.startsWith("t3 node") || line.startsWith("t3 job"))).toBe(
      true,
    );
  });

  it("refuses an unknown topic with a code and names the valid ones", () => {
    const result = runGuide("--topic", "nope", "--json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    const failure = JSON.parse(result.stderr);
    expect(failure.error.code).toBe("NOT_FOUND");
    expect(failure.error.message).toContain("orchestrators");
  });

  it("documents every command group the CLI exposes for automation", () => {
    const groups = new Set(buildCommandCatalog(makeCli()).map((entry) => entry.path[1]));
    for (const group of ["task", "events", "hooks", "orchestrator", "peer", "node", "job"]) {
      expect(groups.has(group), group).toBe(true);
      expect(AGENT_GUIDE).toContain(`t3 ${group} `);
    }
  });
});
