// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { ThreadHandoffError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  makeClaudeSessionHandoffDriver,
  openTransferredClaudeSessionStore,
  type ClaudeSessionSnapshot,
} from "./ClaudeSessionHandoff.ts";

const Snapshot = Schema.Struct({
  format: Schema.Literal("claude-session-store-v1"),
  sessionId: Schema.String,
  transcripts: Schema.Array(
    Schema.Struct({
      subpath: Schema.NullOr(Schema.String),
      file: Schema.String,
      sha256: Schema.String,
      bytes: Schema.Number,
    }),
  ),
});
const Marker = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  snapshot: Snapshot,
});
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(Marker));
const decodeSubkeys = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const digest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const failure = (message: string) =>
  new ThreadHandoffError({ code: "verificationFailed", message });
const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const sessionDirectory = (stateDir: string, threadId: string) =>
  NodePath.join(stateDir, "handoff-sessions", digest(threadId));

async function requireDirectory(directory: string) {
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw failure("Transferred session directory must be server-owned, not a symlink.");
}

async function readRegularFile(filename: string) {
  const stat = await NodeFSP.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw failure("Transferred session metadata and transcripts must be regular files.");
  return NodeFSP.readFile(filename);
}

function guardNativeMirrorWrites(
  store: SessionStore,
  identity: { readonly stateDir: string; readonly threadId: string; readonly sessionId: string },
): SessionStore {
  return {
    ...store,
    async append(key, entries) {
      try {
        await store.append(key, entries);
      } catch (error) {
        // SDK cleanup can swallow exhausted mirror failures before the adapter
        // consumes mirror_error. Quarantine at the write boundary as well.
        await invalidateTransferredClaudeSession({ ...identity, reason: "mirrorError" });
        throw error;
      }
    },
  };
}

/** Install only verified native transcripts, never the caller's whole directory.
 * The marker is written last; provider resume cannot open a partially copied store. */
export async function installTransferredClaudeSession(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly snapshot: ClaudeSessionSnapshot;
  readonly inputDirectory: string;
}): Promise<SessionStore> {
  const driver = makeClaudeSessionHandoffDriver();
  await driver.verify({ snapshot: input.snapshot, directory: input.inputDirectory });
  const parent = NodePath.join(input.stateDir, "handoff-sessions");
  await NodeFSP.mkdir(parent, { recursive: true, mode: 0o700 });
  await requireDirectory(parent);
  const directory = sessionDirectory(input.stateDir, input.threadId);
  // Exclusive ownership prevents overwriting an already continuing native session.
  await NodeFSP.mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    for (const part of input.snapshot.transcripts) {
      const bytes = await readRegularFile(NodePath.join(input.inputDirectory, part.file));
      await NodeFSP.writeFile(NodePath.join(directory, part.file), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    await driver.verify({ snapshot: input.snapshot, directory });
    await NodeFSP.writeFile(
      NodePath.join(directory, "registration.json"),
      JSON.stringify({ version: 1, threadId: input.threadId, snapshot: input.snapshot }),
      { flag: "wx", mode: 0o600 },
    );
    return guardNativeMirrorWrites(openTransferredClaudeSessionStore(input.snapshot, directory), {
      ...input,
      sessionId: input.snapshot.sessionId,
    });
  } catch (error) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Call only after stopping the adapter and verifying the journal grants no
 * local execution ownership. An incomplete installation needs explicit recovery:
 * its hashed directory name alone does not prove which native session it owns. */
export async function removeTransferredClaudeSession(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly sessionId: string;
}): Promise<void> {
  const directory = sessionDirectory(input.stateDir, input.threadId);
  try {
    await requireDirectory(NodePath.join(input.stateDir, "handoff-sessions"));
    await requireDirectory(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const bytes = await readRegularFile(NodePath.join(directory, "registration.json")).catch(
    (error: unknown) => {
      if (isMissing(error))
        throw new ThreadHandoffError({
          code: "recoveryRequired",
          message:
            "Transferred session registration is incomplete; recovery must establish its identity before cleanup.",
        });
      throw error;
    },
  );
  let marker: typeof Marker.Type;
  try {
    marker = decodeMarker(bytes.toString());
  } catch {
    throw new ThreadHandoffError({
      code: "recoveryRequired",
      message:
        "Transferred session registration is invalid; recovery must establish its identity before cleanup.",
    });
  }
  if (marker.threadId !== input.threadId || marker.snapshot.sessionId !== input.sessionId) {
    throw failure("Transferred Claude session identity does not match the requested cleanup.");
  }
  await NodeFSP.rm(directory, { recursive: true, force: true });
}

/** Native mirror failures invalidate the durable copy across provider/server restarts.
 * Store only a controlled diagnostic category, never provider output or secret-bearing errors. */
export async function invalidateTransferredClaudeSession(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly reason: "mirrorError" | "sessionMismatch";
}): Promise<void> {
  const directory = sessionDirectory(input.stateDir, input.threadId);
  await requireDirectory(NodePath.join(input.stateDir, "handoff-sessions"));
  await requireDirectory(directory);
  const marker = decodeMarker(
    (await readRegularFile(NodePath.join(directory, "registration.json"))).toString(),
  );
  if (marker.threadId !== input.threadId || marker.snapshot.sessionId !== input.sessionId)
    throw failure("Transferred Claude session identity does not match the requested invalidation.");
  const reason = input.reason === "sessionMismatch" ? "sessionMismatch" : "mirrorError";
  const invalidFile = NodePath.join(directory, "invalid.json");
  try {
    await NodeFSP.writeFile(invalidFile, JSON.stringify({ version: 1, reason }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    // Existing invalidation is already a durable fence. Never follow or replace it.
  }
}

/** Resolve by trusted server state and thread identity; never accept a session path.
 * Snapshot hashes protect the installed prefix while native append-only writes evolve. */
export async function openTransferredClaudeSession(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly sessionId: string;
}): Promise<SessionStore | undefined> {
  const directory = sessionDirectory(input.stateDir, input.threadId);
  let markerBytes: Buffer;
  try {
    await requireDirectory(NodePath.join(input.stateDir, "handoff-sessions"));
    await requireDirectory(directory);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    markerBytes = await readRegularFile(NodePath.join(directory, "registration.json"));
  } catch (error) {
    if (isMissing(error))
      throw new ThreadHandoffError({
        code: "recoveryRequired",
        message:
          "Transferred session registration is incomplete; resume cannot fall back to another native store.",
      });
    throw error;
  }
  const marker = decodeMarker(markerBytes.toString());
  if (marker.threadId !== input.threadId || marker.snapshot.sessionId !== input.sessionId)
    throw failure(
      "Transferred Claude session identity does not match the requested thread and session.",
    );
  try {
    await NodeFSP.lstat(NodePath.join(directory, "invalid.json"));
    throw new ThreadHandoffError({
      code: "recoveryRequired",
      message:
        "Transferred Claude native history is invalid; repair the session before resume or handoff.",
    });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.sessionId))
    throw failure("Invalid Claude native session ID.");
  const keys = new Set<string | null>();
  for (const part of marker.snapshot.transcripts) {
    if (
      keys.has(part.subpath) ||
      part.file !== `${digest(part.subpath ?? "")}.jsonl` ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 0
    )
      throw failure("Invalid registered Claude transcript identity.");
    keys.add(part.subpath);
    const bytes = await readRegularFile(NodePath.join(directory, part.file));
    if (bytes.length < part.bytes || digest(bytes.subarray(0, part.bytes)) !== part.sha256)
      throw failure("Registered Claude transcript checksum mismatch.");
  }
  if (!keys.has(null)) throw failure("Registered Claude session has no main transcript.");
  try {
    const index = JSON.parse(
      (await readRegularFile(NodePath.join(directory, "store-index.json"))).toString(),
    );
    const subkeys = decodeSubkeys(index);
    for (const subkey of subkeys)
      await readRegularFile(NodePath.join(directory, `${digest(subkey)}.jsonl`));
  } catch (error) {
    if (!isMissing(error)) throw error;
    // Only absence of the optional index is valid; a published missing subagent
    // is detected below by loading every advertised key through the native store.
  }
  const store = openTransferredClaudeSessionStore(marker.snapshot, directory);
  const key = { projectKey: "transferred", sessionId: input.sessionId };
  await store.load(key);
  for (const subpath of await store.listSubkeys!(key)) await store.load({ ...key, subpath });
  return guardNativeMirrorWrites(store, input);
}

/** Re-export this evolving store, including subagents created after arrival.
 * The caller must freeze provider writes before checkpointing. SDK disk discovery
 * cannot find sessions resumed using a custom SessionStore. */
export async function exportTransferredClaudeSession(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly outputDirectory: string;
}): Promise<ClaudeSessionSnapshot | undefined> {
  const source = await openTransferredClaudeSession(input);
  if (!source) return undefined;
  const driver = makeClaudeSessionHandoffDriver(async (sessionId, destination) => {
    const key = { projectKey: "transferred", sessionId };
    for (const subpath of [undefined, ...(await source.listSubkeys!(key))]) {
      const partKey = { ...key, ...(subpath === undefined ? {} : { subpath }) };
      const entries = await source.load(partKey);
      if (entries === null)
        throw failure("Transferred Claude transcript disappeared during export.");
      await destination.append(partKey, entries);
    }
  });
  return driver.checkpoint({
    sessionId: input.sessionId,
    cwd: input.stateDir,
    outputDirectory: input.outputDirectory,
  });
}
