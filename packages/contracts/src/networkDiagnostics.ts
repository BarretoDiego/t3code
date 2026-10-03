import * as Schema from "effect/Schema";

export const TailscaleNodeDiagnostics = Schema.Struct({
  hostName: Schema.String,
  dnsName: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  addresses: Schema.Array(Schema.String),
  online: Schema.Boolean,
  /** Whether a direct (non-relayed) path to the node is in use right now. */
  direct: Schema.Boolean,
  relay: Schema.NullOr(Schema.String),
  lastSeen: Schema.NullOr(Schema.String),
  keyExpiry: Schema.NullOr(Schema.String),
  expired: Schema.Boolean,
});
export type TailscaleNodeDiagnostics = typeof TailscaleNodeDiagnostics.Type;

export const TailscaleServeMappingDiagnostics = Schema.Struct({
  host: Schema.String,
  httpsPort: Schema.Number,
  path: Schema.String,
  /** The local URL requests are proxied to; null for file or text handlers. */
  proxy: Schema.NullOr(Schema.String),
});
export type TailscaleServeMappingDiagnostics = typeof TailscaleServeMappingDiagnostics.Type;

export const TailscaleDiagnostics = Schema.Struct({
  /** `cli-not-found` means the server process could not run `tailscale`, not that Tailscale is absent. */
  availability: Schema.Literals([
    "running",
    "stopped",
    "needs-login",
    "cli-not-found",
    "unavailable",
  ]),
  /** A classified reason the CLI failed, never its raw output. */
  failure: Schema.NullOr(Schema.String),
  backendState: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  tailnetName: Schema.NullOr(Schema.String),
  magicDnsEnabled: Schema.NullOr(Schema.Boolean),
  httpsEnabled: Schema.Boolean,
  health: Schema.Array(Schema.String),
  self: Schema.NullOr(TailscaleNodeDiagnostics),
  peers: Schema.Array(TailscaleNodeDiagnostics),
  /** Null when the Serve configuration could not be read. */
  serve: Schema.NullOr(Schema.Array(TailscaleServeMappingDiagnostics)),
});
export type TailscaleDiagnostics = typeof TailscaleDiagnostics.Type;

/**
 * How an environment's host sees its own network: what the server listens on
 * and the Tailscale state of the machine. A client combines this with what it
 * observes from outside to explain why an environment is unreachable.
 */
export const ServerNetworkDiagnostics = Schema.Struct({
  server: Schema.Struct({
    /** The port the server accepted this connection's HTTP traffic on, when known. */
    port: Schema.NullOr(Schema.Number),
    tailscaleServeEnabled: Schema.Boolean,
    tailscaleServePort: Schema.Number,
  }),
  tailscale: TailscaleDiagnostics,
});
export type ServerNetworkDiagnostics = typeof ServerNetworkDiagnostics.Type;
