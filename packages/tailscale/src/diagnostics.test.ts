import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  parseTailscaleNetworkStatus,
  parseTailscalePing,
  parseTailscaleServeStatus,
  pingTailscalePeer,
  readTailscaleDiagnostics,
} from "./diagnostics.ts";

const encoder = new TextEncoder();

/** A `tailscale` whose answer depends on the subcommand it was run with. */
function tailscaleLayer(
  answer: (args: ReadonlyArray<string>) => { stdout?: string; stderr?: string; code?: number },
) {
  return Layer.merge(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const result = answer(
          (command as unknown as { readonly args: ReadonlyArray<string> }).args,
        );
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }),
    ),
    Layer.succeed(HostProcessPlatform, "linux"),
  );
}

const RUNNING_STATUS = JSON.stringify({
  Version: "1.80.0",
  BackendState: "Running",
  Self: {
    HostName: "desk",
    DNSName: "desk.tail1234.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.64.0.1", "fd7a::1"],
    Online: true,
    KeyExpiry: "2027-01-01T00:00:00Z",
  },
  Health: ["Tailscale is not using system DNS"],
  CurrentTailnet: { Name: "example.com", MagicDNSEnabled: true },
  CertDomains: null,
  Peer: {
    "nodekey:a": {
      HostName: "laptop",
      DNSName: "laptop.tail1234.ts.net.",
      TailscaleIPs: ["100.64.0.2"],
      Online: true,
      CurAddr: "192.168.1.20:41641",
      Relay: "gru",
      LastSeen: "0001-01-01T00:00:00Z",
    },
    "nodekey:b": {
      HostName: "old-server",
      DNSName: "old-server.tail1234.ts.net.",
      Online: false,
      CurAddr: "",
      LastSeen: "2026-09-01T10:00:00Z",
      Expired: true,
    },
  },
});
const LOGGED_OUT_STATUS = JSON.stringify({ BackendState: "NeedsLogin", Self: null, Peer: null });
const SERVE_STATUS = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    "desk.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
    "desk.tail1234.ts.net:8443": { Handlers: { "/docs": { Path: "/srv/docs" } } },
  },
});

describe("tailscale diagnostics", () => {
  it.effect("reads the node, its peers, and tailnet settings from status", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleNetworkStatus(RUNNING_STATUS);

      assert.strictEqual(status.backendState, "Running");
      assert.strictEqual(status.tailnetName, "example.com");
      assert.strictEqual(status.magicDnsEnabled, true);
      assert.strictEqual(status.httpsEnabled, false);
      assert.deepStrictEqual(status.health, ["Tailscale is not using system DNS"]);
      assert.strictEqual(status.self?.dnsName, "desk.tail1234.ts.net");
      assert.strictEqual(status.self?.keyExpiry, "2027-01-01T00:00:00Z");

      const [laptop, oldServer] = status.peers;
      assert.strictEqual(laptop?.direct, true);
      assert.strictEqual(laptop?.lastSeen, null);
      assert.strictEqual(oldServer?.online, false);
      assert.strictEqual(oldServer?.direct, false);
      assert.strictEqual(oldServer?.expired, true);
      assert.strictEqual(oldServer?.lastSeen, "2026-09-01T10:00:00Z");
    }),
  );

  it.effect("reads a logged-out status that has no node or peers", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleNetworkStatus(LOGGED_OUT_STATUS);
      assert.strictEqual(status.backendState, "NeedsLogin");
      assert.strictEqual(status.self, null);
      assert.deepStrictEqual(status.peers, []);
    }),
  );

  it.effect("lists Serve handlers with the local target they proxy to", () =>
    Effect.gen(function* () {
      const mappings = yield* parseTailscaleServeStatus(SERVE_STATUS);
      assert.deepStrictEqual(mappings, [
        {
          host: "desk.tail1234.ts.net",
          httpsPort: 443,
          path: "/",
          proxy: "http://127.0.0.1:3773",
        },
        { host: "desk.tail1234.ts.net", httpsPort: 8443, path: "/docs", proxy: null },
      ]);
    }),
  );

  it.effect("treats an empty Serve configuration as no mappings", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* parseTailscaleServeStatus("{}"), []);
      assert.deepStrictEqual(yield* parseTailscaleServeStatus(""), []);
    }),
  );

  it("reports the settled path of a ping", () => {
    assert.deepStrictEqual(
      parseTailscalePing(
        [
          "pong from laptop (100.64.0.2) via DERP(gru) in 48ms",
          "pong from laptop (100.64.0.2) via 192.168.1.20:41641 in 3ms",
        ].join("\n"),
      ),
      { reachable: true, via: "direct", latencyMs: 3 },
    );
    assert.deepStrictEqual(
      parseTailscalePing(
        "pong from laptop (100.64.0.2) via DERP(gru) in 1.2s\ndirect connection not established\n",
      ),
      { reachable: true, via: "derp", latencyMs: 1200 },
    );
    assert.deepStrictEqual(parseTailscalePing('ping "100.64.0.2" timed out\n'), {
      reachable: false,
      via: null,
      latencyMs: null,
    });
  });

  it.effect("reports a running node together with what Serve publishes", () =>
    Effect.gen(function* () {
      const diagnostics = yield* readTailscaleDiagnostics.pipe(
        Effect.provide(
          tailscaleLayer((args) => ({
            stdout: args[0] === "status" ? RUNNING_STATUS : SERVE_STATUS,
          })),
        ),
      );
      assert.strictEqual(diagnostics.availability, "running");
      assert.strictEqual(diagnostics.self?.dnsName, "desk.tail1234.ts.net");
      assert.strictEqual(diagnostics.serve?.[0]?.proxy, "http://127.0.0.1:3773");
    }),
  );

  it.effect("keeps the node when only the Serve configuration is unreadable", () =>
    Effect.gen(function* () {
      const diagnostics = yield* readTailscaleDiagnostics.pipe(
        Effect.provide(
          tailscaleLayer((args) =>
            args[0] === "status" ? { stdout: RUNNING_STATUS } : { code: 1, stderr: "boom" },
          ),
        ),
      );
      assert.strictEqual(diagnostics.availability, "running");
      assert.strictEqual(diagnostics.serve, null);
    }),
  );

  it.effect("tells a signed-out or stopped daemon apart from a missing CLI", () =>
    Effect.gen(function* () {
      const signedOut = yield* readTailscaleDiagnostics.pipe(
        Effect.provide(tailscaleLayer(() => ({ stdout: LOGGED_OUT_STATUS }))),
      );
      assert.strictEqual(signedOut.availability, "needs-login");

      const denied = yield* readTailscaleDiagnostics.pipe(
        Effect.provide(tailscaleLayer(() => ({ code: 1, stderr: "access denied: tskey-secret" }))),
      );
      assert.strictEqual(denied.availability, "unavailable");
      assert.strictEqual(denied.failure, "permission-denied");

      const missing = yield* readTailscaleDiagnostics.pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                    description: "tailscale not found",
                  }),
                ),
              ),
            ),
            Layer.succeed(HostProcessPlatform, "linux"),
          ),
        ),
      );
      assert.strictEqual(missing.availability, "cli-not-found");
      assert.deepStrictEqual(missing.peers, []);
    }),
  );

  it.effect("reads a relayed ping even though tailscale exits non-zero for it", () =>
    Effect.gen(function* () {
      const ping = yield* pingTailscalePeer("100.64.0.2").pipe(
        Effect.provide(
          tailscaleLayer(() => ({
            code: 1,
            stdout: "pong from laptop (100.64.0.2) via DERP(gru) in 48ms\n",
            stderr: "direct connection not established",
          })),
        ),
      );
      assert.deepStrictEqual(ping, { reachable: true, via: "derp", latencyMs: 48 });
    }),
  );
});
