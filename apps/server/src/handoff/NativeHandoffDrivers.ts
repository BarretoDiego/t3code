// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { importSessionToStore } from "@anthropic-ai/claude-agent-sdk";
import {
  NonNegativeInt,
  ProviderDriverKind,
  ThreadHandoffError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeClaudeSessionHandoffDriver } from "./ClaudeSessionHandoff.ts";
import {
  exportTransferredClaudeSession,
  installTransferredClaudeSession,
  removeTransferredClaudeSession,
  openTransferredClaudeSession,
} from "./TransferredClaudeSession.ts";
import type {
  NativeSessionCompatibility,
  NativeSessionEndpoint,
} from "./ProviderSessionHandoff.ts";

export interface NativeHandoffDriver {
  readonly preflightSource: (input: { readonly sessionId: string }) => Promise<void>;
  readonly remove: (input: { readonly sessionId: string }) => Promise<void>;
  readonly driver: ProviderDriverKind;
  readonly sessionIdFromCursor: (cursor: unknown) => string;
  readonly preflight: (
    source: NativeSessionEndpoint,
    destination: NativeSessionEndpoint,
  ) => NativeSessionCompatibility;
  readonly checkpoint: (input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly outputDirectory: string;
  }) => Promise<unknown>;
  readonly verify: (input: {
    readonly sessionId: string;
    readonly directory: string;
  }) => Promise<void>;
  readonly install: (input: {
    readonly sessionId: string;
    readonly directory: string;
  }) => Promise<void>;
}
export interface NativeHandoffDriverInput {
  readonly driver: ProviderDriverKind;
  readonly stateDir: string;
  readonly threadId: ThreadId;
  readonly sourceHomePath?: string;
}
export interface NativeHandoffDriverDependencies {
  readonly claudeExportSession?: typeof importSessionToStore;
}
const Uuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
);
const isUuid = Schema.is(Uuid);
const isResumeCursor = Schema.is(
  Schema.Struct({
    resume: Schema.optional(Schema.Unknown),
    sessionId: Schema.optional(Schema.Unknown),
  }),
);
const NativeSnapshot = Schema.Struct({
  format: Schema.Literal("claude-session-store-v1"),
  sessionId: Uuid,
  transcripts: Schema.Array(
    Schema.Struct({
      subpath: Schema.NullOr(Schema.String),
      file: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.jsonl$/)),
      sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      bytes: NonNegativeInt,
    }),
  ).check(Schema.isMinLength(1)),
});
const decodeNativeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(NativeSnapshot), {
  onExcessProperty: "error",
});
const invalid = (message: string) =>
  new ThreadHandoffError({ code: "verificationFailed", message });

function createClaudeDriver(
  input: NativeHandoffDriverInput,
  dependencies: NativeHandoffDriverDependencies,
): NativeHandoffDriver {
  const native = makeClaudeSessionHandoffDriver(dependencies.claudeExportSession);
  const validateHome = () => {
    const sdkHome = process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude");
    const home = input.sourceHomePath?.trim();
    const expanded = home?.startsWith("~/") ? NodePath.join(NodeOS.homedir(), home.slice(2)) : home;
    if (expanded && NodePath.resolve(expanded) !== NodePath.resolve(sdkHome))
      throw new ThreadHandoffError({
        code: "unsupported",
        message:
          "Native export from this custom Claude home is unsupported. The source home must match the server's Claude configuration.",
      });
  };
  const readVerified = async ({
    sessionId,
    directory,
  }: {
    readonly sessionId: string;
    readonly directory: string;
  }) => {
    const filename = NodePath.join(directory, "snapshot.json");
    const stat = await NodeFSP.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw invalid("Native session metadata must be a regular file.");
    const snapshot = decodeNativeSnapshot(await NodeFSP.readFile(filename, "utf8"));
    if (snapshot.sessionId !== sessionId)
      throw invalid("Native snapshot belongs to a different session.");
    await native.verify({ snapshot, directory });
    return snapshot;
  };
  return {
    async preflightSource({ sessionId }) {
      if (
        await openTransferredClaudeSession({
          stateDir: input.stateDir,
          threadId: input.threadId,
          sessionId,
        })
      )
        return;
      validateHome();
    },
    remove: ({ sessionId }) =>
      removeTransferredClaudeSession({
        stateDir: input.stateDir,
        threadId: input.threadId,
        sessionId,
      }),
    driver: native.driver,
    sessionIdFromCursor(cursor) {
      if (isResumeCursor(cursor)) {
        const candidate = typeof cursor.resume === "string" ? cursor.resume : cursor.sessionId;
        if (isUuid(candidate)) return candidate;
      }
      throw new ThreadHandoffError({
        code: "unsupported",
        message: "This thread has no valid Claude native resume session ID.",
      });
    },
    preflight: native.preflight,
    async checkpoint(checkpoint) {
      const transferred = await exportTransferredClaudeSession({
        stateDir: input.stateDir,
        threadId: input.threadId,
        sessionId: checkpoint.sessionId,
        outputDirectory: checkpoint.outputDirectory,
      });
      if (transferred) return transferred;
      // SDK discovery uses its process configuration. Changing global env here
      // would cross configured provider instances and can export the wrong one.
      validateHome();
      return native.checkpoint(checkpoint);
    },
    async verify(request) {
      await readVerified(request);
    },
    async install(request) {
      const snapshot = await readVerified(request);
      await installTransferredClaudeSession({
        stateDir: input.stateDir,
        threadId: input.threadId,
        snapshot,
        inputDirectory: request.directory,
      });
    },
  };
}
const factories = new Map<ProviderDriverKind, typeof createClaudeDriver>([
  [ProviderDriverKind.make("claudeAgent"), createClaudeDriver],
]);

/** Driver boundaries own native storage and verification. The runtime never
 * branches on provider names or reconstructs a session from conversation text. */
export function getNativeHandoffDriver(
  input: NativeHandoffDriverInput,
  dependencies: NativeHandoffDriverDependencies = {},
): NativeHandoffDriver | undefined {
  return factories.get(input.driver)?.(input, dependencies);
}
