/**
 * The findings `t3 doctor` reports, derived from facts it already gathered.
 * Everything here is pure: `doctor.ts` collects the facts (HTTP, sockets,
 * `tailscale`), these functions say what they mean and what to do about it.
 */
import type {
  ExecutionEnvironmentDescriptor,
  ServerNetworkDiagnostics,
  TailscaleDiagnostics,
  TailscaleNodeDiagnostics,
} from "@t3tools/contracts";
import { isTailscaleIpv4Address, type TailscalePing } from "@t3tools/tailscale";

type DoctorStatus = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  /** What to do about a warning or failure. */
  readonly hint?: string;
}

export interface DoctorSection {
  readonly id: string;
  readonly title: string;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

const KEY_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const check = (id: string, status: DoctorStatus, summary: string, hint?: string): DoctorCheck =>
  hint === undefined ? { id, status, summary } : { id, status, summary, hint };

// ---------------------------------------------------------------------------
// Routes

type RouteKind = "loopback" | "tailscale" | "lan" | "public";

interface EnvironmentRoute {
  readonly kind: RouteKind;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

function isPrivateHost(host: string): boolean {
  if (host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".")) return true;
  const [first, second] = host.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

/** How a client reaches the environment at `origin`, judged from the URL alone. */
export function classifyRoute(origin: string): EnvironmentRoute {
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const secure = url.protocol === "https:";
  const port = url.port === "" ? (secure ? 443 : 80) : Number(url.port);
  const kind: RouteKind =
    host === "localhost" || host === "::1" || host.startsWith("127.")
      ? "loopback"
      : host.endsWith(".ts.net") ||
          isTailscaleIpv4Address(host) ||
          host.startsWith("fd7a:115c:a1e0")
        ? "tailscale"
        : isPrivateHost(host)
          ? "lan"
          : "public";
  return { kind, host, port, secure };
}

const ROUTE_LABELS: Record<RouteKind, string> = {
  loopback: "this machine only (loopback)",
  tailscale: "Tailscale",
  lan: "local network",
  public: "public address or tunnel",
};

export const routeCheck = (origin: string, route: EnvironmentRoute): DoctorCheck =>
  check("route", "info", `${origin} is reached over ${ROUTE_LABELS[route.kind]}.`);

// ---------------------------------------------------------------------------
// Tailscale on one machine

/**
 * Whether Tailscale on a machine is usable. `required` is false when nothing
 * being checked depends on Tailscale, so its absence is a fact, not a fault.
 */
export function tailscaleChecks(input: {
  readonly tailscale: TailscaleDiagnostics;
  readonly required: boolean;
  readonly nowMs: number;
}): ReadonlyArray<DoctorCheck> {
  const { tailscale, required } = input;
  const broken: DoctorStatus = required ? "fail" : "info";
  switch (tailscale.availability) {
    case "cli-not-found":
      return [
        check(
          "tailscale",
          required ? "warn" : "info",
          "The `tailscale` command is not on this process's PATH, so Tailscale cannot be inspected.",
          "Install the Tailscale CLI (macOS: Tailscale menu → Settings → CLI integration) or start T3 Code from a shell that has it on PATH.",
        ),
      ];
    case "stopped":
      return [
        check("tailscale", broken, "Tailscale is installed but stopped.", "Run `tailscale up`."),
      ];
    case "needs-login":
      return [
        check(
          "tailscale",
          broken,
          "Tailscale is not signed in to a tailnet.",
          "Run `tailscale login` (or `tailscale up`) and finish the sign-in.",
        ),
      ];
    case "unavailable":
      return [
        check(
          "tailscale",
          broken,
          `Tailscale did not answer${tailscale.failure === null ? "" : ` (${tailscale.failure})`}${tailscale.backendState === null ? "" : `; state ${tailscale.backendState}`}.`,
          tailscale.failure === "permission-denied"
            ? "Allow this user to talk to tailscaled: `sudo tailscale set --operator=$USER`."
            : "Check that tailscaled is running: `tailscale status`.",
        ),
      ];
    case "running":
      break;
  }

  const self = tailscale.self;
  const checks: Array<DoctorCheck> = [
    check(
      "tailscale",
      "ok",
      `Tailscale is running${self?.dnsName ? ` as ${self.dnsName}` : ""}${self?.addresses[0] ? ` (${self.addresses[0]})` : ""}${tailscale.tailnetName ? ` on tailnet ${tailscale.tailnetName}` : ""}.`,
    ),
  ];
  if (tailscale.magicDnsEnabled === false) {
    checks.push(
      check(
        "tailscale-magicdns",
        "warn",
        "MagicDNS is disabled, so `*.ts.net` names do not resolve.",
        "Enable MagicDNS in the Tailscale admin console (DNS), or use the 100.x address.",
      ),
    );
  }
  if (!tailscale.httpsEnabled) {
    checks.push(
      check(
        "tailscale-https",
        required ? "warn" : "info",
        "HTTPS certificates are not enabled for this tailnet, so Tailscale Serve cannot publish an https:// URL.",
        "Enable HTTPS Certificates in the Tailscale admin console (DNS).",
      ),
    );
  }
  if (self?.expired === true) {
    checks.push(
      check(
        "tailscale-key",
        "fail",
        "This node's Tailscale key has expired; peers can no longer reach it.",
        "Re-authenticate with `tailscale up --force-reauth`.",
      ),
    );
  } else if (self?.keyExpiry) {
    const remainingMs = Date.parse(self.keyExpiry) - input.nowMs;
    if (Number.isFinite(remainingMs) && remainingMs < KEY_EXPIRY_WARNING_MS) {
      checks.push(
        check(
          "tailscale-key",
          "warn",
          `This node's Tailscale key expires on ${self.keyExpiry}.`,
          "Re-authenticate with `tailscale up --force-reauth`, or disable key expiry for the node in the admin console.",
        ),
      );
    }
  }
  for (const [index, message] of tailscale.health.entries()) {
    checks.push(check(`tailscale-health-${index + 1}`, "warn", `Tailscale reports: ${message}`));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Tailscale Serve on the environment's host

function loopbackPortOf(proxy: string | null): number | null {
  if (proxy === null) return null;
  try {
    const url = new URL(proxy);
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "::1" && host !== "[::1]" && !host.startsWith("127.")) {
      return null;
    }
    return url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  } catch {
    return null;
  }
}

/**
 * Whether Tailscale Serve on the host forwards to the T3 server. `route` is
 * the URL a client uses, when that goes through Serve (https to a tailnet
 * name); without it only the server's own configuration is checked.
 */
export function serveChecks(input: {
  readonly diagnostics: ServerNetworkDiagnostics;
  readonly route: EnvironmentRoute | null;
}): ReadonlyArray<DoctorCheck> {
  const { server, tailscale } = input.diagnostics;
  const throughServe =
    input.route !== null &&
    input.route.kind === "tailscale" &&
    input.route.secure &&
    input.route.host.endsWith(".ts.net");
  if (!throughServe && !server.tailscaleServeEnabled) return [];
  if (tailscale.availability !== "running") return [];

  const servePort = throughServe ? input.route.port : server.tailscaleServePort;
  const repair =
    "On that machine run `t3 pair --tailscale`, or `tailscale serve --bg --https=" +
    `${servePort} http://127.0.0.1:${server.port ?? "<port>"}\`.`;
  if (tailscale.serve === null) {
    return [
      check(
        "tailscale-serve",
        "warn",
        "The Tailscale Serve configuration could not be read on the host.",
        "Run `tailscale serve status` there.",
      ),
    ];
  }
  const mapping = tailscale.serve.find(
    (entry) =>
      entry.httpsPort === servePort &&
      entry.path === "/" &&
      (!throughServe || entry.host.toLowerCase() === input.route.host),
  );
  if (mapping === undefined) {
    return [
      check(
        "tailscale-serve",
        "fail",
        `Tailscale Serve publishes nothing on HTTPS port ${servePort}, so the tailnet URL has no server behind it.`,
        repair,
      ),
    ];
  }
  const target = loopbackPortOf(mapping.proxy);
  if (server.port !== null && target !== server.port) {
    return [
      check(
        "tailscale-serve",
        "fail",
        `Tailscale Serve forwards https://${mapping.host}:${mapping.httpsPort} to ${mapping.proxy ?? "a non-proxy handler"}, but T3 Code listens on port ${server.port}.`,
        repair,
      ),
    ];
  }
  return [
    check(
      "tailscale-serve",
      "ok",
      `Tailscale Serve forwards https://${mapping.host}${mapping.httpsPort === 443 ? "" : `:${mapping.httpsPort}`} to ${mapping.proxy}.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// One tailnet node as seen from another

/** The node `host` names in `tailscale`'s view: by MagicDNS name, short name, or address. */
export function findTailscaleNode(
  tailscale: TailscaleDiagnostics,
  host: string,
): { readonly node: TailscaleNodeDiagnostics; readonly isSelf: boolean } | null {
  const wanted = host.toLowerCase();
  const matches = (node: TailscaleNodeDiagnostics) =>
    node.dnsName?.toLowerCase() === wanted ||
    node.dnsName?.toLowerCase().split(".")[0] === wanted ||
    node.addresses.some((address) => address.toLowerCase() === wanted);
  if (tailscale.self !== null && matches(tailscale.self)) {
    return { node: tailscale.self, isSelf: true };
  }
  const peer = tailscale.peers.find(matches);
  return peer === undefined ? null : { node: peer, isSelf: false };
}

/**
 * Whether `viewer` can reach the tailnet node `host`. `ping` is the result of
 * a Tailscale ping from the viewer, when one could be run.
 */
export function peerChecks(input: {
  readonly id: string;
  readonly viewer: string;
  readonly host: string;
  readonly tailscale: TailscaleDiagnostics;
  readonly ping: TailscalePing | null;
}): ReadonlyArray<DoctorCheck> {
  const { id, viewer, host, tailscale, ping } = input;
  if (tailscale.availability !== "running") {
    return [
      check(
        id,
        "fail",
        `${viewer} cannot reach ${host}: Tailscale is not running there.`,
        "Fix Tailscale on that machine first (see its Tailscale check).",
      ),
    ];
  }
  const found = findTailscaleNode(tailscale, host);
  if (found === null) {
    return [
      check(
        id,
        "fail",
        `${host} is not a node ${viewer} can see${tailscale.tailnetName ? ` in tailnet ${tailscale.tailnetName}` : ""}.`,
        "Both machines must be signed in to the same tailnet (or the node shared with it). The node may also have been removed or renamed.",
      ),
    ];
  }
  if (found.isSelf) return [check(id, "ok", `${host} is ${viewer} itself.`)];
  const { node } = found;
  if (node.expired) {
    return [
      check(
        id,
        "fail",
        `${host}'s Tailscale key has expired, so ${viewer} cannot reach it.`,
        `Run \`tailscale up --force-reauth\` on ${node.hostName}.`,
      ),
    ];
  }
  if (!node.online) {
    return [
      check(
        id,
        "fail",
        `${host} is offline in the tailnet${node.lastSeen ? ` (last seen ${node.lastSeen})` : ""}.`,
        `Wake ${node.hostName} or start Tailscale on it.`,
      ),
    ];
  }
  if (ping === null) return [check(id, "ok", `${viewer} sees ${host} online in the tailnet.`)];
  if (!ping.reachable) {
    return [
      check(
        id,
        "fail",
        `${host} is online in the tailnet but does not answer a Tailscale ping from ${viewer}.`,
        "Check the tailnet ACLs and any firewall blocking UDP between the two machines.",
      ),
    ];
  }
  if (ping.via !== "direct") {
    return [
      check(
        id,
        "warn",
        `${viewer} reaches ${host} only through a relay (${ping.via}, ${ping.latencyMs}ms); expect a slow connection.`,
        "A NAT or firewall blocks the direct path. Allow UDP 41641, or see `tailscale netcheck`.",
      ),
    ];
  }
  return [check(id, "ok", `${viewer} reaches ${host} directly (${ping.latencyMs}ms).`)];
}

// ---------------------------------------------------------------------------
// HTTP reachability

const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** Explains a failed request to the environment from the error codes in its cause chain. */
export function connectFailureCheck(input: {
  readonly origin: string;
  readonly route: EnvironmentRoute;
  readonly codes: ReadonlyArray<string>;
}): DoctorCheck {
  const { origin, route, codes } = input;
  const has = (...wanted: ReadonlyArray<string>) => wanted.some((code) => codes.includes(code));
  if (has("ENOTFOUND", "EAI_AGAIN")) {
    return check(
      "http",
      "fail",
      `The name ${route.host} does not resolve.`,
      route.kind === "tailscale"
        ? "Tailscale must be running on this machine with MagicDNS enabled, and the node must still exist under that name."
        : "Check the address saved for this environment (`t3 env list`).",
    );
  }
  if (has("ECONNREFUSED")) {
    return check(
      "http",
      "fail",
      `${route.host} refused the connection on port ${route.port}: the machine is up but nothing listens there.`,
      route.kind === "tailscale" && route.secure
        ? "Tailscale Serve is not configured on that machine. Run `t3 pair --tailscale` there."
        : "Start T3 Code on that machine. If it is running, it listens on another port or only on loopback: start it with --host set to a reachable address, or publish it with `t3 pair --tailscale`.",
    );
  }
  if (codes.some((code) => CERTIFICATE_CODES.has(code))) {
    return check(
      "http",
      "fail",
      `The HTTPS certificate of ${route.host} was rejected (${codes.find((code) => CERTIFICATE_CODES.has(code))}).`,
      route.kind === "tailscale"
        ? "Enable HTTPS Certificates for the tailnet; a new Serve URL can take a minute to get its first certificate."
        : "The server presents a certificate this machine does not trust.",
    );
  }
  if (has("TIMEOUT", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "EHOSTUNREACH", "ENETUNREACH")) {
    return check(
      "http",
      "fail",
      `${origin} did not answer in time.`,
      route.kind === "tailscale"
        ? "The machine is asleep, off the tailnet, or blocked by ACLs."
        : "The machine is off, asleep, on another network, or behind a firewall.",
    );
  }
  return check(
    "http",
    "fail",
    `Could not connect to ${origin}${codes.length === 0 ? "" : ` (${codes.join(", ")})`}.`,
  );
}

/** Explains an HTTP answer that is not a T3 Code descriptor. */
export function unexpectedStatusCheck(input: {
  readonly origin: string;
  readonly route: EnvironmentRoute;
  readonly status: number;
}): DoctorCheck {
  const { origin, route, status } = input;
  if (status === 502 || status === 503 || status === 504) {
    return check(
      "http",
      "fail",
      `A proxy answers at ${origin} (HTTP ${status}) but the T3 Code server behind it does not.`,
      route.kind === "tailscale"
        ? "The server is stopped, or Tailscale Serve still forwards to an old port. Start T3 Code there, then run `t3 pair --tailscale` on that machine to repair the mapping."
        : "Start T3 Code on that machine, or fix the proxy or tunnel target.",
    );
  }
  return check(
    "http",
    "fail",
    `${origin} answers HTTP ${status}, which is not a T3 Code server.`,
    "Another service owns this address. Check the URL and port saved for this environment.",
  );
}

// ---------------------------------------------------------------------------
// Between environments

interface EnvironmentReport {
  readonly name: string;
  /** Set when the environment is reachable and usable from this machine. */
  readonly descriptor: Pick<
    ExecutionEnvironmentDescriptor,
    "environmentId" | "capabilities"
  > | null;
  /** The host's own Tailscale state, when it could report it. */
  readonly tailscale: TailscaleDiagnostics | null;
}

const CROSS_ENVIRONMENT_FEATURES = [
  ["projectSync", "Project sync"],
  ["threadHandoff", "Thread handoff"],
] as const;

/**
 * What works between each pair of environments. Sync and handoff are driven
 * by the client, which talks to both sides, so they need both servers to
 * support them and nothing between the hosts. Only features that connect
 * hosts directly (an AI runtime shared over the tailnet) depend on the hosts
 * seeing each other, which is why a missing tailnet path is a warning here.
 * Environments that are unreachable are left out: their own section says why.
 */
export function betweenEnvironmentsChecks(
  reports: ReadonlyArray<EnvironmentReport>,
): ReadonlyArray<DoctorCheck> {
  const reachable = reports.flatMap((report) =>
    report.descriptor === null ? [] : [{ name: report.name, descriptor: report.descriptor }],
  );
  const features = reachable.flatMap((left, index) =>
    reachable
      .slice(index + 1)
      // Two names for the same environment (the local server and a saved entry for it).
      .filter((right) => right.descriptor.environmentId !== left.descriptor.environmentId)
      .flatMap((right) => {
        const missing = CROSS_ENVIRONMENT_FEATURES.flatMap(([capability, label]) => {
          const lacking = [left, right]
            .filter((environment) => environment.descriptor.capabilities[capability] !== true)
            .map((environment) => environment.name);
          return lacking.length === 0
            ? []
            : [
                check(
                  `${left.name}<->${right.name}:${capability}`,
                  "warn",
                  `${label} between ${left.name} and ${right.name} is unavailable: ${lacking.join(" and ")} ${lacking.length === 1 ? "does" : "do"} not support it.`,
                  `Update T3 Code on ${lacking.join(" and ")}.`,
                ),
              ];
        });
        return missing.length > 0
          ? missing
          : [
              check(
                `${left.name}<->${right.name}`,
                "ok",
                `Projects can be synced and threads handed off between ${left.name} and ${right.name}; this machine reaches both.`,
              ),
            ];
      }),
  );

  const onTailnet = reports.flatMap((report) =>
    report.tailscale !== null &&
    report.tailscale.availability === "running" &&
    report.tailscale.self?.dnsName
      ? [{ name: report.name, tailscale: report.tailscale, dnsName: report.tailscale.self.dnsName }]
      : [],
  );
  const paths = onTailnet.flatMap((viewer) =>
    onTailnet
      .filter((target) => target.name !== viewer.name && target.dnsName !== viewer.dnsName)
      .flatMap((target) =>
        peerChecks({
          id: `${viewer.name}->${target.name}`,
          viewer: viewer.name,
          host: target.dnsName,
          tailscale: viewer.tailscale,
          ping: null,
        }).map((entry) =>
          entry.status === "fail" ? { ...entry, status: "warn" as const } : entry,
        ),
      ),
  );
  return [...features, ...paths];
}

// ---------------------------------------------------------------------------
// Report

const STATUS_MARKS: Record<DoctorStatus, string> = { ok: "✓", info: "·", warn: "!", fail: "✗" };

export const countByStatus = (sections: ReadonlyArray<DoctorSection>, status: DoctorStatus) =>
  sections.reduce(
    (total, section) => total + section.checks.filter((entry) => entry.status === status).length,
    0,
  );

export function formatDoctorReport(sections: ReadonlyArray<DoctorSection>): string {
  const lines = sections.flatMap((section) => [
    section.title,
    ...section.checks.flatMap((entry) => [
      `  ${STATUS_MARKS[entry.status]} ${entry.summary}`,
      ...(entry.hint === undefined ? [] : [`      → ${entry.hint}`]),
    ]),
    "",
  ]);
  const failures = countByStatus(sections, "fail");
  const warnings = countByStatus(sections, "warn");
  lines.push(
    failures === 0 && warnings === 0
      ? "No problems found."
      : `${failures} problem${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}

/** The checks whose status or wording changed since `previous`, for `--watch`. */
export function changedChecks(
  previous: ReadonlyArray<DoctorSection>,
  next: ReadonlyArray<DoctorSection>,
): ReadonlyArray<{
  readonly section: string;
  readonly check: DoctorCheck;
  readonly was: DoctorStatus | null;
}> {
  const before = new Map(
    previous.flatMap((section) =>
      section.checks.map((entry) => [`${section.id}/${entry.id}`, entry] as const),
    ),
  );
  const after = new Set(
    next.flatMap((section) => section.checks.map((entry) => `${section.id}/${entry.id}`)),
  );
  return [
    ...next.flatMap((section) =>
      section.checks.flatMap((entry) => {
        const old = before.get(`${section.id}/${entry.id}`);
        return old?.status === entry.status
          ? []
          : [{ section: section.title, check: entry, was: old?.status ?? null }];
      }),
    ),
    // A check that disappeared was a finding that no longer applies.
    ...previous.flatMap((section) =>
      section.checks.flatMap((entry) =>
        after.has(`${section.id}/${entry.id}`) || entry.status === "ok" || entry.status === "info"
          ? []
          : [
              {
                section: section.title,
                check: {
                  id: entry.id,
                  status: "ok" as const,
                  summary: `Resolved: ${entry.summary}`,
                },
                was: entry.status,
              },
            ],
      ),
    ),
  ];
}
