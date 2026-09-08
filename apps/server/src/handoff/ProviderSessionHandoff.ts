import type { ProviderDriverKind } from "@t3tools/contracts";

export interface NativeSessionCompatibility {
  readonly mode: "native" | "unsupported";
  readonly reason?: string;
  readonly warnings: readonly string[];
}
export interface NativeSessionEndpoint {
  readonly driver: ProviderDriverKind;
  readonly version: string | null;
  readonly authenticated: boolean;
  readonly cwd: string;
}

/** Providers own the native storage format and path portability decision.
 * Transport carries their opaque snapshot through Project Sync. Restoring a
 * session never authorizes execution; the ownership transaction does that. */
export interface ProviderSessionHandoffDriver<Snapshot> {
  readonly driver: ProviderDriverKind;
  readonly preflight: (
    source: NativeSessionEndpoint,
    destination: NativeSessionEndpoint,
  ) => NativeSessionCompatibility;
  readonly checkpoint: (input: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly outputDirectory: string;
  }) => Promise<Snapshot>;
  readonly verify: (input: {
    readonly snapshot: Snapshot;
    readonly directory: string;
  }) => Promise<void>;
}

export function preflightNativeSession(
  source: NativeSessionEndpoint,
  destination: NativeSessionEndpoint,
): NativeSessionCompatibility {
  if (source.driver !== destination.driver)
    return {
      mode: "unsupported",
      reason: "Native handoff requires the same provider.",
      warnings: [],
    };
  if (!destination.authenticated)
    return {
      mode: "unsupported",
      reason: "Authenticate the provider on the destination first.",
      warnings: [],
    };
  if (!source.version || source.version !== destination.version)
    return {
      mode: "unsupported",
      reason: "Native handoff requires identical verified provider versions.",
      warnings: [],
    };
  return {
    mode: "native",
    warnings:
      source.cwd === destination.cwd
        ? []
        : [
            "Project path changes. Local services, MCP paths and historical tool paths are not relocated.",
          ],
  };
}
