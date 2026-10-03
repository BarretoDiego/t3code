import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  runTailscale,
  spawnTailscale,
  TailscaleStatusParseError,
  type TailscaleStderrDiagnostic,
} from "./tailscale.ts";

const TAILSCALE_DIAGNOSTICS_TIMEOUT = Duration.seconds(4);
const TAILSCALE_PING_TIMEOUT = Duration.seconds(10);
// Go's zero time, which tailscale prints for "never" (an online peer's LastSeen).
const ZERO_TIME_PREFIX = "0001-01-01";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const strings = (value: unknown): Array<string> =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];

const timestamp = (value: unknown): string | null => {
  const parsed = text(value);
  return parsed === null || parsed.startsWith(ZERO_TIME_PREFIX) ? null : parsed;
};

const dnsName = (value: unknown): string | null => text(value)?.replace(/\.$/u, "") || null;

const decodeJsonRecord = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

function parseNode(raw: unknown) {
  if (!isRecord(raw)) return null;
  return {
    hostName: text(raw.HostName) ?? "unknown",
    dnsName: dnsName(raw.DNSName),
    os: text(raw.OS),
    addresses: strings(raw.TailscaleIPs),
    online: raw.Online === true,
    /** Whether a direct (non-relayed) path to the node is in use right now. */
    direct: text(raw.CurAddr) !== null,
    relay: text(raw.Relay),
    lastSeen: timestamp(raw.LastSeen),
    keyExpiry: timestamp(raw.KeyExpiry),
    expired: raw.Expired === true,
  };
}
type TailscaleNode = NonNullable<ReturnType<typeof parseNode>>;

/** The parts of `tailscale status --json` that explain why a peer is or is not reachable. */
export const parseTailscaleNetworkStatus = (rawStatusJson: string) =>
  decodeJsonRecord(rawStatusJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((status) => {
      const tailnet = isRecord(status.CurrentTailnet) ? status.CurrentTailnet : {};
      return {
        backendState: text(status.BackendState),
        version: text(status.Version),
        tailnetName: text(tailnet.Name),
        magicDnsEnabled:
          typeof tailnet.MagicDNSEnabled === "boolean" ? tailnet.MagicDNSEnabled : null,
        // Tailscale lists certificate domains only once HTTPS is enabled for the tailnet.
        httpsEnabled: strings(status.CertDomains).length > 0,
        health: strings(status.Health),
        self: parseNode(status.Self),
        peers: (isRecord(status.Peer) ? Object.values(status.Peer) : []).flatMap((peer) => {
          const node = parseNode(peer);
          return node === null ? [] : [node];
        }),
      };
    }),
  );

function splitHostPort(value: string): { readonly host: string; readonly port: number } | null {
  const separator = value.lastIndexOf(":");
  const port = Number(value.slice(separator + 1));
  return separator <= 0 || !Number.isInteger(port)
    ? null
    : { host: value.slice(0, separator), port };
}

/** The HTTPS handlers in `tailscale serve status --json`, one per served path. */
export const parseTailscaleServeStatus = (rawServeJson: string) =>
  decodeJsonRecord(rawServeJson.trim().length === 0 ? "{}" : rawServeJson).pipe(
    Effect.mapError((cause) => new TailscaleStatusParseError({ cause })),
    Effect.map((serve) =>
      Object.entries(isRecord(serve.Web) ? serve.Web : {}).flatMap(([hostPort, site]) => {
        const endpoint = splitHostPort(hostPort);
        const handlers = isRecord(site) && isRecord(site.Handlers) ? site.Handlers : {};
        return endpoint === null
          ? []
          : Object.entries(handlers).map(([path, handler]) => ({
              host: endpoint.host,
              httpsPort: endpoint.port,
              path,
              /** The local URL requests are proxied to; null for file or text handlers. */
              proxy: isRecord(handler) ? text(handler.Proxy) : null,
            }));
      }),
    ),
  );

type TailscaleAvailability =
  | "running"
  | "stopped"
  | "needs-login"
  | "cli-not-found"
  | "unavailable";

function availabilityOf(backendState: string | null): TailscaleAvailability {
  switch (backendState) {
    case "Running":
      return "running";
    case "Stopped":
      return "stopped";
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return "needs-login";
    default:
      return "unavailable";
  }
}

const unavailable = (
  availability: TailscaleAvailability,
  failure: TailscaleStderrDiagnostic | "timeout" | null,
) => ({
  availability,
  failure,
  backendState: null,
  version: null,
  tailnetName: null,
  magicDnsEnabled: null,
  httpsEnabled: false,
  health: [] as Array<string>,
  self: null,
  peers: [] as Array<TailscaleNode>,
  serve: null,
});

/**
 * This machine's Tailscale state as the calling process sees it: whether the
 * CLI and daemon are usable, the node and its peers, and what Tailscale Serve
 * publishes. Never fails; an unusable Tailscale is itself the finding.
 */
export const readTailscaleDiagnostics = Effect.gen(function* () {
  const status = yield* runTailscale(
    "status",
    ["status", "--json"],
    TAILSCALE_DIAGNOSTICS_TIMEOUT,
  ).pipe(Effect.flatMap(parseTailscaleNetworkStatus), Effect.result);
  if (status._tag === "Failure") {
    const error = status.failure;
    switch (error._tag) {
      case "TailscaleCommandSpawnError":
        return unavailable("cli-not-found", null);
      case "TailscaleCommandTimeoutError":
        return unavailable("unavailable", "timeout");
      case "TailscaleCommandExitError":
        return unavailable(
          error.stderrDiagnostic === "not-logged-in" ? "needs-login" : "unavailable",
          error.stderrDiagnostic ?? null,
        );
      default:
        return unavailable("unavailable", null);
    }
  }
  // `null` means the Serve configuration could not be read, not that it is empty.
  const serve = yield* runTailscale(
    "serve",
    ["serve", "status", "--json"],
    TAILSCALE_DIAGNOSTICS_TIMEOUT,
  ).pipe(
    Effect.flatMap(parseTailscaleServeStatus),
    Effect.orElseSucceed(() => null),
  );
  return {
    ...status.success,
    availability: availabilityOf(status.success.backendState),
    failure: null as TailscaleStderrDiagnostic | "timeout" | null,
    serve,
  };
});

const PONG_PATTERN = /^pong from .+ via (\S+) in (\d+(?:\.\d+)?)(ms|s)\b/u;

/** Reads `tailscale ping` output: whether the peer answered, and over which path. */
export function parseTailscalePing(stdout: string) {
  const pongs = stdout.split("\n").flatMap((line) => {
    const match = PONG_PATTERN.exec(line.trim());
    if (match === null) return [];
    const [, path = "", amount = "0", unit] = match;
    return [
      {
        via: path.startsWith("DERP")
          ? ("derp" as const)
          : path.startsWith("peer-relay")
            ? ("peer-relay" as const)
            : ("direct" as const),
        latencyMs: Math.round(Number(amount) * (unit === "s" ? 1000 : 1)),
      },
    ];
  });
  // tailscale keeps pinging until the path goes direct, so the last pong is the settled path.
  const settled = pongs.at(-1);
  return settled === undefined
    ? { reachable: false as const, via: null, latencyMs: null }
    : { reachable: true as const, ...settled };
}
export type TailscalePing = ReturnType<typeof parseTailscalePing>;

/**
 * Pings a tailnet node through Tailscale itself, which separates "the tailnet
 * path is broken" from "the service on that node is broken". `target` must be
 * a node name or address taken from `tailscale status`, never raw user input.
 */
export const pingTailscalePeer = (target: string) =>
  spawnTailscale("ping", ["ping", "--c", "3", "--timeout", "2s", target], TAILSCALE_PING_TIMEOUT)
    // A non-zero exit also means "answered, but only through a relay", so read the output.
    .pipe(
      Effect.map((result) => parseTailscalePing(result.stdout)),
      Effect.orElseSucceed(() => parseTailscalePing("")),
    );
