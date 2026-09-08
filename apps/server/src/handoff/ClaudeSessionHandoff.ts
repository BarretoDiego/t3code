// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
  type SessionKey,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind, ThreadHandoffError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  preflightNativeSession,
  type ProviderSessionHandoffDriver,
} from "./ProviderSessionHandoff.ts";

const SessionEntry = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
const decodeEntries = Schema.decodeUnknownSync(Schema.Array(SessionEntry));
const decodeIndexKeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const digest = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const validSessionId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const failure = (message: string) =>
  new ThreadHandoffError({ code: "verificationFailed", message });

export interface ClaudeSessionSnapshot {
  readonly format: "claude-session-store-v1";
  readonly sessionId: string;
  readonly transcripts: readonly {
    readonly subpath: string | null;
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}

/** Use the SDK's native export, including subagent transcripts and compaction
 * records. Do not reconstruct native state from T3's rendered messages. */
export function makeClaudeSessionHandoffDriver(
  exportSession: typeof importSessionToStore = importSessionToStore,
): ProviderSessionHandoffDriver<ClaudeSessionSnapshot> {
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    preflight: (source, destination) =>
      source.driver !== "claudeAgent"
        ? { mode: "unsupported", reason: "This driver requires Claude Code.", warnings: [] }
        : preflightNativeSession(source, destination),
    async checkpoint({ sessionId, cwd, outputDirectory }) {
      if (!validSessionId(sessionId)) throw failure("Invalid Claude native session ID.");
      await NodeFSP.mkdir(outputDirectory, { recursive: false, mode: 0o700 });
      const parts = new Map<string, { subpath: string | null; file: string }>();
      try {
        const store: SessionStore = {
          async append(key, entries) {
            if (key.sessionId !== sessionId)
              throw failure("Native export returned a different session.");
            decodeEntries(entries);
            const name = key.subpath ?? "";
            const file = `${digest(name)}.jsonl`;
            parts.set(name, { subpath: key.subpath ?? null, file });
            await NodeFSP.appendFile(
              NodePath.join(outputDirectory, file),
              entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
              { mode: 0o600 },
            );
          },
          async load() {
            return null;
          },
        };
        await exportSession(sessionId, store, { dir: cwd, includeSubagents: true, batchSize: 500 });
        if (!parts.has("")) throw failure("Claude native session has no main transcript.");
        const transcripts: Array<ClaudeSessionSnapshot["transcripts"][number]> = [];
        for (const part of parts.values()) {
          const bytes = await NodeFSP.readFile(NodePath.join(outputDirectory, part.file));
          transcripts.push({ ...part, sha256: digest(bytes), bytes: bytes.length });
        }
        const snapshot: ClaudeSessionSnapshot = {
          format: "claude-session-store-v1",
          sessionId,
          transcripts,
        };
        await NodeFSP.writeFile(
          NodePath.join(outputDirectory, "snapshot.json"),
          JSON.stringify(snapshot),
          {
            mode: 0o600,
          },
        );
        return snapshot;
      } catch (error) {
        await NodeFSP.rm(outputDirectory, { recursive: true, force: true });
        throw error;
      }
    },
    async verify({ snapshot, directory }) {
      if (!validSessionId(snapshot.sessionId) || snapshot.format !== "claude-session-store-v1")
        throw failure("Invalid Claude session snapshot.");
      const keys = new Set<string | null>();
      for (const part of snapshot.transcripts) {
        if (
          keys.has(part.subpath) ||
          part.file !== `${digest(part.subpath ?? "")}.jsonl` ||
          (part.subpath !== null &&
            (!part.subpath ||
              part.subpath.includes("\\") ||
              part.subpath
                .split("/")
                .some((segment) => !segment || segment === ".." || segment === ".")))
        ) {
          throw failure("Invalid Claude transcript identity.");
        }
        keys.add(part.subpath);
        const filename = NodePath.join(directory, part.file);
        const stat = await NodeFSP.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw failure("Invalid native transcript file.");
        const bytes = await NodeFSP.readFile(filename);
        if (bytes.length !== part.bytes || digest(bytes) !== part.sha256)
          throw failure("Claude session checksum mismatch.");
        decodeEntries(
          bytes
            .toString()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      }
      if (!keys.has(null)) throw failure("Claude native session has no main transcript.");
    },
  };
}

/** Scoped to one native session. The SDK supplies the destination project key;
 * native entries stay unchanged while that key maps to the transferred store.
 * Continuing writes append to this durable destination copy, never the source. */
export function openTransferredClaudeSessionStore(
  snapshot: ClaudeSessionSnapshot,
  directory: string,
): SessionStore {
  const parts = new Map(snapshot.transcripts.map((part) => [part.subpath ?? "", part.file]));
  const publishedKeys = new Set(parts.keys());
  const queues = new Map<string, Promise<void>>();
  const indexFile = NodePath.join(directory, "store-index.json");
  const initialize = NodeFSP.readFile(indexFile, "utf8")
    .then((text) => {
      const keys = decodeIndexKeys(JSON.parse(text));
      for (const key of keys) {
        parts.set(key, `${digest(key)}.jsonl`);
        publishedKeys.add(key);
      }
    })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  let indexWrite = Promise.resolve();
  const entryIds = new Map<string, Set<string>>();
  const checkKey = (key: SessionKey) => {
    if (key.sessionId !== snapshot.sessionId)
      throw failure("Native resume attempted a different session.");
    const subpath = key.subpath ?? "";
    if (subpath.includes("\\") || subpath.split("/").some((part) => part === ".." || part === "."))
      throw failure("Unsafe Claude subagent key.");
    return subpath;
  };
  const load = async (key: SessionKey): Promise<SessionStoreEntry[] | null> => {
    await initialize;
    const subpath = checkKey(key);
    const file = parts.get(subpath);
    if (!file) return null;
    const entries = decodeEntries(
      (await NodeFSP.readFile(NodePath.join(directory, file), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    return [...entries];
  };
  return {
    load,
    async listSubkeys(key) {
      await initialize;
      checkKey(key);
      return [...parts.keys()].filter(Boolean);
    },
    async append(key, entries) {
      await initialize;
      const subpath = checkKey(key);
      decodeEntries(entries);
      const previous = queues.get(subpath) ?? Promise.resolve();
      const operation = previous.then(async () => {
        let ids = entryIds.get(subpath);
        if (!ids) {
          ids = new Set(
            ((await load(key)) ?? []).flatMap((entry) =>
              typeof entry.uuid === "string" ? [entry.uuid] : [],
            ),
          );
          entryIds.set(subpath, ids);
        }
        const fresh = entries.filter(
          (entry) => typeof entry.uuid !== "string" || !ids.has(entry.uuid),
        );
        const file = parts.get(subpath) ?? `${digest(subpath)}.jsonl`;
        await NodeFSP.appendFile(
          NodePath.join(directory, file),
          fresh.map((entry) => JSON.stringify(entry) + "\n").join(""),
          { mode: 0o600 },
        );
        parts.set(subpath, file);
        // The transcript write has landed even if publishing its key fails.
        // Retried SDK batches must not append those UUIDs a second time.
        for (const entry of fresh) if (typeof entry.uuid === "string") ids.add(entry.uuid);
        if (!publishedKeys.has(subpath)) {
          const write = indexWrite.then(async () => {
            if (publishedKeys.has(subpath)) return;
            const keys = [...parts.keys()];
            await NodeFSP.writeFile(`${indexFile}.tmp`, JSON.stringify(keys), {
              mode: 0o600,
            });
            await NodeFSP.rename(`${indexFile}.tmp`, indexFile);
            // Only this successfully published snapshot is durable. Keys added
            // while the rename awaited must still schedule their own write.
            for (const key of keys) publishedKeys.add(key);
          });
          indexWrite = write.catch(() => {});
          await write;
        }
      });
      queues.set(
        subpath,
        operation.catch(() => {}),
      );
      await operation;
    },
  };
}
