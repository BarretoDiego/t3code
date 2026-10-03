/**
 * `t3 doctor` - explains why an environment is or is not reachable.
 *
 * It looks at a connection from both ends: what this machine observes from
 * outside (Tailscale path, HTTP, credential, WebSocket) and what the
 * environment's host reports about itself over `server.getNetworkDiagnostics`.
 * The findings and their wording live in `doctorChecks.ts`.
 */
import {
  EnvironmentHttpApi,
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  type TailscaleDiagnostics,
  WS_METHODS,
} from "@t3tools/contracts";
import { pingTailscalePeer, readTailscaleDiagnostics } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import packageJson from "../../package.json" with { type: "json" };
import { jsonFlag, printJson, printJsonLine } from "./common.ts";
import { DurationFromString } from "./config.ts";
import {
  changedChecks,
  classifyRoute,
  connectFailureCheck,
  countByStatus,
  type DoctorCheck,
  type DoctorSection,
  betweenEnvironmentsChecks,
  findTailscaleNode,
  formatDoctorReport,
  peerChecks,
  routeCheck,
  serveChecks,
  tailscaleChecks,
  unexpectedStatusCheck,
} from "./doctorChecks.ts";
import {
  environmentTargetFlags,
  findSavedEnvironment,
  openEnvironmentRpc,
  readSavedEnvironments,
  withEnvironmentRuntime,
  withLocalEnvironmentTarget,
} from "./environmentRpc.ts";

const HTTP_TIMEOUT = Duration.seconds(8);
const RPC_TIMEOUT = Duration.seconds(10);
// The host runs `tailscale` twice to answer, each with its own timeout.
const HOST_REPORT_TIMEOUT = Duration.seconds(12);
const SESSION_EXPIRY_WARNING = Duration.days(7);

export class DoctorFoundProblemsError extends Schema.TaggedError<DoctorFoundProblemsError>()(
  "DoctorFoundProblemsError",
  { problems: Schema.Number },
) {
  override get message(): string {
    return `t3 doctor found ${this.problems} problem${this.problems === 1 ? "" : "s"}.`;
  }
}

/** Node and undici put the reason a request failed in `code`, somewhere down the cause chain. */
function errorCodes(error: unknown): Array<string> {
  const codes: Array<string> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (typeof value !== "object" || value === null || seen.has(value) || depth > 8) return;
    seen.add(value);
    const { code, cause, reason } = value as {
      readonly code?: unknown;
      readonly cause?: unknown;
      readonly reason?: unknown;
    };
    if (typeof code === "string" && !codes.includes(code)) codes.push(code);
    visit(reason, depth + 1);
    visit(cause, depth + 1);
  };
  visit(error, 0);
  return codes;
}

const fetchDescriptor = Effect.fn("cli.doctor.fetchDescriptor")(function* (origin: string) {
  const client = yield* HttpClient.HttpClient;
  const startedAt = yield* Clock.currentTimeMillis;
  const response = yield* client
    .execute(HttpClientRequest.get(new URL("/.well-known/t3/environment", origin).toString()))
    .pipe(
      Effect.timeoutOrElse({
        duration: HTTP_TIMEOUT,
        orElse: () => Effect.fail({ code: "TIMEOUT" }),
      }),
      Effect.result,
    );
  if (response._tag === "Failure") {
    return { _tag: "failed", codes: errorCodes(response.failure) } as const;
  }
  const descriptor = yield* HttpClientResponse.filterStatusOk(response.success).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.option,
  );
  return Option.match(descriptor, {
    // A 2xx that is not a descriptor is still some other service at this address.
    onNone: () => ({ _tag: "status", status: response.success.status }) as const,
    onSome: (value) => ({ _tag: "descriptor", descriptor: value, startedAt }) as const,
  });
});

interface EnvironmentInspection {
  readonly name: string;
  readonly section: DoctorSection;
  /** Set when every layer up to the WebSocket works, so the environment is usable from here. */
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  /** The host's own Tailscale state, when it could be asked. */
  readonly tailscale: TailscaleDiagnostics | null;
}

/**
 * Checks one environment from the outside in, stopping at the first layer
 * that fails: later layers cannot work and would only repeat the cause.
 */
const inspectEnvironment = Effect.fn("cli.doctor.inspectEnvironment")(function* (input: {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly origin: string;
  readonly token: string;
  /** The environment a saved entry was paired with; null for the local server. */
  readonly expectedEnvironmentId: string | null;
  readonly machine: TailscaleDiagnostics;
}) {
  const { origin, machine } = input;
  const local = input.expectedEnvironmentId === null;
  const route = classifyRoute(origin);
  const checks: Array<DoctorCheck> = [routeCheck(origin, route)];
  const done = (
    usable: ExecutionEnvironmentDescriptor | null = null,
    tailscale: TailscaleDiagnostics | null = null,
  ): EnvironmentInspection => ({
    name: input.name,
    section: { id: input.id, title: input.title, checks },
    descriptor: usable,
    tailscale,
  });

  if (route.kind === "tailscale") {
    const found =
      machine.availability === "running" ? findTailscaleNode(machine, route.host) : null;
    // Ping the address tailscale itself reported, never the saved URL's host.
    const pingTarget =
      found !== null && !found.isSelf && found.node.online
        ? (found.node.addresses[0] ?? found.node.dnsName)
        : null;
    checks.push(
      ...peerChecks({
        id: "tailnet",
        viewer: "This machine",
        host: route.host,
        tailscale: machine,
        ping: pingTarget === null ? null : yield* pingTailscalePeer(pingTarget),
      }),
    );
  }

  const http = yield* fetchDescriptor(origin);
  if (http._tag === "failed") {
    checks.push(connectFailureCheck({ origin, route, codes: http.codes }));
    return done();
  }
  if (http._tag === "status") {
    checks.push(unexpectedStatusCheck({ origin, route, status: http.status }));
    return done();
  }
  const { descriptor } = http;
  checks.push({
    id: "http",
    status: "ok",
    summary: `T3 Code ${descriptor.serverVersion} answers as "${descriptor.label}" in ${(yield* Clock.currentTimeMillis) - http.startedAt}ms.`,
  });
  if (
    input.expectedEnvironmentId !== null &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    checks.push({
      id: "identity",
      status: "fail",
      summary: `A different environment answers at this address than the one saved as ${input.name}.`,
      hint: `The server was reinstalled or another one took over the address. Pair again: \`t3 env add ${input.name} <pairing-link>\`.`,
    });
    return done();
  }
  // Missing metadata denotes protocol 1, from before servers advertised it.
  const serverProtocol = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocol !== ORCHESTRATION_PROTOCOL_VERSION) {
    const serverIsOlder = serverProtocol < ORCHESTRATION_PROTOCOL_VERSION;
    checks.push({
      id: "protocol",
      status: "fail",
      summary: `The server speaks orchestration protocol ${serverProtocol} and this CLI speaks ${ORCHESTRATION_PROTOCOL_VERSION}, so they cannot connect.`,
      hint: serverIsOlder
        ? "Update T3 Code on that machine (`t3 update` there)."
        : "Update T3 Code on this machine (`t3 update`).",
    });
    return done();
  }
  if (descriptor.serverVersion !== packageJson.version) {
    checks.push({
      id: "version",
      status: "info",
      summary: `The server runs ${descriptor.serverVersion}; this CLI is ${packageJson.version}.`,
    });
  }

  const repair = `Pair again: \`t3 env add ${input.name} <pairing-link>\`.`;
  const api = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
  const session = yield* api.auth
    .session({ headers: { authorization: `Bearer ${input.token}` } })
    .pipe(Effect.timeout(HTTP_TIMEOUT), Effect.option);
  if (Option.isNone(session) || !session.value.authenticated) {
    checks.push({
      id: "credential",
      status: "fail",
      summary: Option.isNone(session)
        ? "The server did not answer the credential check."
        : local
          ? "The running server rejected a session issued from this CLI's data directory."
          : "The saved credential is no longer accepted: it expired or was revoked.",
      hint: local
        ? "The CLI and the server are different versions or use different data directories. Run the `t3` that belongs to the running server, or pass its --base-dir."
        : repair,
    });
    return done();
  }
  const expiresAt = session.value.expiresAt;
  const expiresSoon =
    expiresAt !== undefined &&
    DateTime.toEpochMillis(expiresAt) - (yield* Clock.currentTimeMillis) <
      Duration.toMillis(SESSION_EXPIRY_WARNING);
  checks.push(
    expiresSoon
      ? {
          id: "credential",
          status: "warn",
          summary: `The credential is accepted but expires on ${DateTime.formatIso(expiresAt)}.`,
          hint: repair,
        }
      : { id: "credential", status: "ok", summary: "The credential is accepted." },
  );

  const rpc = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* openEnvironmentRpc(origin, input.token);
      const startedAt = yield* Clock.currentTimeMillis;
      yield* client[WS_METHODS.serverProbe]({});
      const latencyMs = (yield* Clock.currentTimeMillis) - startedAt;
      // Servers from before this method existed reject it; that is not a fault.
      const network = yield* client[WS_METHODS.serverGetNetworkDiagnostics]({}).pipe(
        Effect.timeout(HOST_REPORT_TIMEOUT),
        Effect.option,
        Effect.catchCause(() => Effect.succeedNone),
      );
      return { latencyMs, network };
    }),
  ).pipe(Effect.timeout(Duration.sum(RPC_TIMEOUT, HOST_REPORT_TIMEOUT)), Effect.option);
  if (Option.isNone(rpc)) {
    checks.push({
      id: "rpc",
      status: "fail",
      summary: "HTTP works, but the WebSocket connection the apps and the CLI use does not.",
      hint: "Something between the two machines blocks WebSocket upgrades (a proxy or tunnel), or the server is overloaded.",
    });
    return done();
  }
  checks.push({
    id: "rpc",
    status: "ok",
    summary: `The WebSocket connection works (round trip ${rpc.value.latencyMs}ms).`,
  });
  if (Option.isNone(rpc.value.network)) {
    checks.push({
      id: "host",
      status: "info",
      summary:
        "This server cannot report its own network state; update it to diagnose its Tailscale setup.",
    });
    return done(descriptor);
  }

  const host = rpc.value.network.value;
  if (local) {
    // The "This machine" section already covers Tailscale; what matters here
    // is whether the server process sees the same thing as this shell.
    if (host.tailscale.availability !== machine.availability) {
      checks.push({
        id: "host-tailscale",
        status: "warn",
        summary: `The server process sees Tailscale as "${host.tailscale.availability}" while this shell sees "${machine.availability}".`,
        hint: "The server was started with a different PATH or user. Restart it from an environment where `tailscale status` works.",
      });
    }
  } else {
    checks.push(
      ...tailscaleChecks({
        tailscale: host.tailscale,
        required: route.kind === "tailscale" || host.server.tailscaleServeEnabled,
        nowMs: yield* Clock.currentTimeMillis,
      }).map((entry) => ({ ...entry, id: `host-${entry.id}`, summary: `Host: ${entry.summary}` })),
    );
  }
  checks.push(...serveChecks({ diagnostics: host, route: local ? null : route }));

  const machineName = machine.self?.dnsName;
  if (
    !local &&
    route.kind === "tailscale" &&
    machine.availability === "running" &&
    host.tailscale.availability === "running" &&
    machineName &&
    host.tailscale.self?.dnsName !== machineName
  ) {
    checks.push(
      ...peerChecks({
        id: "tailnet-reverse",
        viewer: input.name,
        host: machineName,
        tailscale: host.tailscale,
        ping: null,
      }),
    );
  }
  return done(descriptor, host.tailscale);
});

interface DoctorFlags {
  readonly baseDir: Option.Option<string>;
  readonly env: Option.Option<string>;
  readonly all: boolean;
}

/** One full diagnosis: this machine, each selected environment, and the paths between them. */
const diagnose = Effect.fn("cli.doctor.diagnose")(function* (
  flags: DoctorFlags,
  config: Parameters<Parameters<typeof withEnvironmentRuntime>[1]>[0],
) {
  const saved = yield* readSavedEnvironments;
  const selected = flags.all
    ? saved
    : Option.isSome(flags.env)
      ? [yield* findSavedEnvironment(flags.env.value)]
      : [];
  const includeLocal = flags.all || Option.isNone(flags.env);
  const machine = yield* readTailscaleDiagnostics;

  const machineChecks = [
    ...tailscaleChecks({
      tailscale: machine,
      required: selected.some(
        (environment) => classifyRoute(environment.httpBaseUrl).kind === "tailscale",
      ),
      nowMs: yield* Clock.currentTimeMillis,
    }),
  ];
  if (selected.length === 0 && saved.length > 0) {
    machineChecks.push({
      id: "unchecked",
      status: "info",
      summary: `${saved.length} saved environment${saved.length === 1 ? " was" : "s were"} not checked (${saved.map((environment) => environment.name).join(", ")}).`,
      hint: "Check them with `t3 doctor --all`, or one with `t3 doctor --env <name>`.",
    });
  }

  const local: ReadonlyArray<EnvironmentInspection> = includeLocal
    ? [
        yield* withLocalEnvironmentTarget(config, (target) =>
          inspectEnvironment({
            id: "local",
            name: "local",
            title: "Local server",
            origin: target.origin,
            token: target.token,
            expectedEnvironmentId: null,
            machine,
          }),
        ).pipe(
          Effect.catchTag("EnvironmentServerNotRunningError", () =>
            Effect.succeed<EnvironmentInspection>({
              name: "local",
              descriptor: null,
              section: {
                id: "local",
                title: "Local server",
                checks: [
                  {
                    id: "http",
                    status: "warn",
                    summary: "No T3 Code server is running on this machine.",
                    hint: "Start the desktop app or run `t3`.",
                  },
                ],
              },
              tailscale: null,
            }),
          ),
        ),
      ]
    : [];
  const remote = yield* Effect.forEach(
    selected,
    (environment) =>
      inspectEnvironment({
        id: `env:${environment.name}`,
        name: environment.name,
        title: `Environment ${environment.name} (${environment.label})`,
        origin: environment.httpBaseUrl,
        token: environment.token,
        expectedEnvironmentId: environment.environmentId,
        machine,
      }),
    { concurrency: 4 },
  );

  const between = betweenEnvironmentsChecks([...local, ...remote]);
  return [
    { id: "machine", title: "This machine", checks: machineChecks },
    ...local.map((inspection) => inspection.section),
    ...remote.map((inspection) => inspection.section),
    ...(between.length === 0
      ? []
      : [{ id: "between", title: "Between environments", checks: between }]),
  ] satisfies ReadonlyArray<DoctorSection>;
});

export const doctorCommand = Command.make("doctor", {
  ...environmentTargetFlags,
  all: Flag.Boolean("all").pipe(
    Flag.withDescription(
      "Check this machine, every saved environment, and the tailnet paths between them.",
    ),
    Flag.withDefault(false),
  ),
  watch: Flag.String("watch").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription(
      "Keep checking at this interval (e.g. 30s, 5m) and print each check that changes.",
    ),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Diagnose connections to environments: Tailscale, reachability, credentials, and Tailscale Serve on each host.",
  ),
  Command.withHandler((flags) =>
    withEnvironmentRuntime(flags, (config) =>
      Effect.gen(function* () {
        const first = yield* diagnose(flags, config);
        yield* flags.json
          ? printJson({ ok: countByStatus(first, "fail") === 0, sections: first })
          : Console.log(formatDoctorReport(first));

        if (Option.isNone(flags.watch)) {
          const problems = countByStatus(first, "fail");
          return problems === 0 ? undefined : yield* new DoctorFoundProblemsError({ problems });
        }

        let previous: ReadonlyArray<DoctorSection> = first;
        return yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(flags.watch.pipe(Option.getOrThrow));
            const next = yield* diagnose(flags, config);
            const at = DateTime.formatIso(yield* DateTime.now);
            for (const change of changedChecks(previous, next)) {
              yield* flags.json
                ? printJsonLine({ at, ...change })
                : Console.log(
                    [
                      `${at}  ${change.section}: ${change.was ?? "new"} → ${change.check.status}  ${change.check.summary}`,
                      ...(change.check.hint === undefined ? [] : [`      → ${change.check.hint}`]),
                    ].join("\n"),
                  );
            }
            previous = next;
          }),
        );
      }),
    ),
  ),
);
