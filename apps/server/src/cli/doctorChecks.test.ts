import {
  EnvironmentId,
  type ServerNetworkDiagnostics,
  type TailscaleDiagnostics,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  betweenEnvironmentsChecks,
  changedChecks,
  classifyRoute,
  connectFailureCheck,
  peerChecks,
  serveChecks,
  tailscaleChecks,
  unexpectedStatusCheck,
} from "./doctorChecks.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");

const node = (name: string, overrides: Partial<TailscaleDiagnostics["peers"][number]> = {}) => ({
  hostName: name,
  dnsName: `${name}.tail1234.ts.net`,
  os: "linux",
  addresses: [`100.64.0.${name.length}`],
  online: true,
  direct: true,
  relay: "gru",
  lastSeen: null,
  keyExpiry: null,
  expired: false,
  ...overrides,
});

const tailscale = (overrides: Partial<TailscaleDiagnostics> = {}): TailscaleDiagnostics => ({
  availability: "running",
  failure: null,
  backendState: "Running",
  version: "1.80.0",
  tailnetName: "example.com",
  magicDnsEnabled: true,
  httpsEnabled: true,
  health: [],
  self: node("desk"),
  peers: [node("laptop")],
  serve: [],
  ...overrides,
});

const host = (
  serve: TailscaleDiagnostics["serve"],
  server: Partial<ServerNetworkDiagnostics["server"]> = {},
): ServerNetworkDiagnostics => ({
  server: { port: 3773, tailscaleServeEnabled: false, tailscaleServePort: 443, ...server },
  tailscale: tailscale({ self: node("laptop"), peers: [node("desk")], serve }),
});

const statuses = (checks: ReadonlyArray<{ readonly id: string; readonly status: string }>) =>
  checks.map((entry) => `${entry.id}:${entry.status}`);

describe("doctor checks", () => {
  it("classifies how an environment URL is reached", () => {
    assert.deepStrictEqual(classifyRoute("https://laptop.tail1234.ts.net/"), {
      kind: "tailscale",
      host: "laptop.tail1234.ts.net",
      port: 443,
      secure: true,
    });
    assert.strictEqual(classifyRoute("http://100.101.102.103:3774/").kind, "tailscale");
    assert.strictEqual(classifyRoute("http://127.0.0.1:3773").kind, "loopback");
    assert.strictEqual(classifyRoute("http://192.168.1.20:3773").kind, "lan");
    assert.strictEqual(classifyRoute("http://studio.local:3773").kind, "lan");
    // 100.x outside the CGNAT range Tailscale uses is an ordinary public address.
    assert.strictEqual(classifyRoute("https://100.1.2.3/").kind, "public");
    assert.strictEqual(classifyRoute("https://t3.example.com/").kind, "public");
  });

  it("only treats a stopped Tailscale as a problem when a route depends on it", () => {
    const stopped = tailscale({ availability: "stopped", self: null, peers: [] });
    assert.deepStrictEqual(
      statuses(tailscaleChecks({ tailscale: stopped, required: true, nowMs: NOW })),
      ["tailscale:fail"],
    );
    assert.deepStrictEqual(
      statuses(tailscaleChecks({ tailscale: stopped, required: false, nowMs: NOW })),
      ["tailscale:info"],
    );
  });

  it("warns about tailnet settings and keys that will break the connection", () => {
    const checks = tailscaleChecks({
      tailscale: tailscale({
        magicDnsEnabled: false,
        httpsEnabled: false,
        health: ["Tailscale is not using system DNS"],
        self: node("desk", { keyExpiry: "2026-10-03T00:00:00Z" }),
      }),
      required: true,
      nowMs: NOW,
    });
    assert.deepStrictEqual(statuses(checks), [
      "tailscale:ok",
      "tailscale-magicdns:warn",
      "tailscale-https:warn",
      "tailscale-key:warn",
      "tailscale-health-1:warn",
    ]);
    assert.deepStrictEqual(
      statuses(
        tailscaleChecks({
          tailscale: tailscale({ self: node("desk", { expired: true }) }),
          required: true,
          nowMs: NOW,
        }),
      ),
      ["tailscale:ok", "tailscale-key:fail"],
    );
  });

  it("finds a Serve mapping that is missing or points at the wrong port", () => {
    const route = classifyRoute("https://laptop.tail1234.ts.net/");
    const mapping = (proxy: string) => [
      { host: "laptop.tail1234.ts.net", httpsPort: 443, path: "/", proxy },
    ];

    assert.deepStrictEqual(
      statuses(serveChecks({ diagnostics: host(mapping("http://127.0.0.1:3773")), route })),
      ["tailscale-serve:ok"],
    );

    const [stale] = serveChecks({ diagnostics: host(mapping("http://127.0.0.1:3999")), route });
    assert.strictEqual(stale?.status, "fail");
    assert.include(stale?.summary, "listens on port 3773");

    const [missing] = serveChecks({ diagnostics: host([]), route });
    assert.strictEqual(missing?.status, "fail");
    assert.include(missing?.hint, "t3 pair --tailscale");

    // A mapping on another HTTPS port does not serve the URL the client uses.
    assert.deepStrictEqual(
      statuses(
        serveChecks({
          diagnostics: host([{ ...mapping("http://127.0.0.1:3773")[0]!, httpsPort: 8443 }]),
          route,
        }),
      ),
      ["tailscale-serve:fail"],
    );
  });

  it("checks Serve only when the route or the server's settings use it", () => {
    const direct = classifyRoute("http://100.101.102.103:3774/");
    assert.deepStrictEqual(serveChecks({ diagnostics: host([]), route: direct }), []);
    assert.deepStrictEqual(
      statuses(
        serveChecks({ diagnostics: host([], { tailscaleServeEnabled: true }), route: direct }),
      ),
      ["tailscale-serve:fail"],
    );
    assert.deepStrictEqual(
      statuses(
        serveChecks({ diagnostics: host(null, { tailscaleServeEnabled: true }), route: null }),
      ),
      ["tailscale-serve:warn"],
    );
  });

  it("explains why a tailnet node cannot be reached", () => {
    const verdict = (view: TailscaleDiagnostics, ping: Parameters<typeof peerChecks>[0]["ping"]) =>
      peerChecks({
        id: "tailnet",
        viewer: "This machine",
        host: "laptop.tail1234.ts.net",
        tailscale: view,
        ping,
      })[0]!;

    assert.include(verdict(tailscale({ peers: [] }), null).summary, "not a node");
    assert.include(
      verdict(
        tailscale({ peers: [node("laptop", { online: false, lastSeen: "2026-09-01T10:00:00Z" })] }),
        null,
      ).summary,
      "offline in the tailnet (last seen 2026-09-01T10:00:00Z)",
    );
    assert.include(
      verdict(tailscale({ peers: [node("laptop", { expired: true })] }), null).summary,
      "key has expired",
    );
    assert.strictEqual(
      verdict(tailscale(), { reachable: false, via: null, latencyMs: null }).status,
      "fail",
    );
    assert.strictEqual(
      verdict(tailscale(), { reachable: true, via: "derp", latencyMs: 80 }).status,
      "warn",
    );
    assert.strictEqual(
      verdict(tailscale(), { reachable: true, via: "direct", latencyMs: 3 }).status,
      "ok",
    );
    assert.strictEqual(verdict(tailscale({ availability: "stopped" }), null).status, "fail");
  });

  it("matches a node by address or short name as well as its MagicDNS name", () => {
    const byAddress = peerChecks({
      id: "tailnet",
      viewer: "This machine",
      host: "100.64.0.6",
      tailscale: tailscale(),
      ping: null,
    });
    assert.deepStrictEqual(statuses(byAddress), ["tailnet:ok"]);
    const self = peerChecks({
      id: "tailnet",
      viewer: "This machine",
      host: "desk",
      tailscale: tailscale(),
      ping: null,
    });
    assert.include(self[0]?.summary, "itself");
  });

  it("turns connection errors into the likely cause", () => {
    const serve = classifyRoute("https://laptop.tail1234.ts.net/");
    const direct = classifyRoute("http://192.168.1.20:3773/");
    const explain = (route: typeof serve, codes: ReadonlyArray<string>) =>
      connectFailureCheck({ origin: "origin", route, codes });

    assert.include(explain(serve, ["ECONNREFUSED"]).hint, "Tailscale Serve is not configured");
    assert.include(explain(direct, ["ECONNREFUSED"]).hint, "--host");
    assert.include(explain(serve, ["ENOTFOUND"]).hint, "MagicDNS");
    assert.include(explain(serve, ["CERT_HAS_EXPIRED"]).summary, "certificate");
    assert.include(explain(direct, ["TIMEOUT"]).summary, "did not answer in time");
    assert.include(explain(direct, ["EPIPE"]).summary, "EPIPE");

    assert.include(
      unexpectedStatusCheck({ origin: "origin", route: serve, status: 502 }).hint,
      "old port",
    );
    assert.include(
      unexpectedStatusCheck({ origin: "origin", route: serve, status: 404 }).summary,
      "not a T3 Code server",
    );
  });

  it("says what works between each pair of environments", () => {
    const environment = (id: string, capabilities: Record<string, boolean> = {}) => ({
      environmentId: EnvironmentId.make(id),
      capabilities: { repositoryIdentity: true, ...capabilities },
    });
    const current = { projectSync: true, threadHandoff: true };
    const checks = betweenEnvironmentsChecks([
      { name: "desk", descriptor: environment("a", current), tailscale: tailscale() },
      {
        name: "laptop",
        descriptor: environment("b", current),
        tailscale: tailscale({ self: node("laptop"), peers: [node("desk", { online: false })] }),
      },
      { name: "old", descriptor: environment("c", { projectSync: true }), tailscale: null },
      // The same environment saved under a second name is not a pair.
      { name: "desk-lan", descriptor: environment("a", current), tailscale: tailscale() },
      { name: "unreachable", descriptor: null, tailscale: null },
    ]);
    assert.deepStrictEqual(statuses(checks), [
      "desk<->laptop:ok",
      "desk<->old:threadHandoff:warn",
      "laptop<->old:threadHandoff:warn",
      "laptop<->desk-lan:ok",
      "old<->desk-lan:threadHandoff:warn",
      // Hosts that do not see each other only break host-to-host features.
      "desk->laptop:ok",
      "laptop->desk:warn",
      "laptop->desk-lan:warn",
      "desk-lan->laptop:ok",
    ]);
    assert.include(checks[1]?.summary, "old does not support it");
  });

  it("reports checks that changed, appeared, or cleared between two runs", () => {
    const section = (
      checks: ReadonlyArray<{ id: string; status: "ok" | "fail"; summary: string }>,
    ) => [{ id: "env:laptop", title: "Environment laptop", checks }];
    const changes = changedChecks(
      section([
        { id: "http", status: "ok", summary: "answers" },
        { id: "tailnet", status: "ok", summary: "direct" },
        { id: "identity", status: "fail", summary: "wrong server" },
      ]),
      section([
        { id: "http", status: "fail", summary: "refused" },
        { id: "tailnet", status: "ok", summary: "direct" },
      ]),
    );
    assert.deepStrictEqual(
      changes.map((change) => `${change.check.id}:${change.was}->${change.check.status}`),
      ["http:ok->fail", "identity:fail->ok"],
    );
  });
});
