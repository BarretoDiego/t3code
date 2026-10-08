import {
  type AutomationJournalEntry,
  type HookDeliveryPayload,
  type HookTarget,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { automationError } from "../Caller.ts";
import * as OrchestratorInbox from "../OrchestratorInbox.ts";
import * as HookTargetPolicy from "./HookTargetPolicy.ts";
import {
  isPublicAddress,
  literalAddress,
  signWebhook,
  WEBHOOK_DEDUP_KEY_HEADER,
  WEBHOOK_DELIVERY_ID_HEADER,
  WEBHOOK_HOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookSecretName,
} from "./webhook.ts";
import * as WebhookTransport from "./WebhookTransport.ts";

const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WEBHOOK_SECRET_BYTES = 32;
const COMMAND_STDERR_LIMIT = 400;

/** Event types that only report state. A delivery made of nothing else never opens a turn alone. */
const INFORMATIONAL_EVENT_TYPES = new Set<string>([
  "thread.created",
  "thread.organized",
  "thread.deleted",
  "turn.started",
  "task.accepted",
  "task.progress",
  "job.accepted",
  "job.started",
  "node.availability",
  "peer.availability",
]);

/**
 * Why an attempt did not reach its target. `permanent` failures are not
 * retried: policy refused the target, and trying again would be refused again.
 */
export class HookDeliveryFailure extends Schema.TaggedError<HookDeliveryFailure>()(
  "HookDeliveryFailure",
  { reason: Schema.String, permanent: Schema.Boolean },
) {
  override get message(): string {
    return this.reason;
  }
}

const refused = (reason: string) => new HookDeliveryFailure({ reason, permanent: true });
const failed = (reason: string) => new HookDeliveryFailure({ reason, permanent: false });

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** A target as it may be shown: no secret reference, no URL credentials or query. */
export const describeTarget = (target: HookTarget): Record<string, string | number> => {
  switch (target.type) {
    case "orchestrator_inbox":
      return { type: target.type, orchestratorId: target.orchestratorId };
    case "cli_consumer":
      return { type: target.type, consumerId: target.consumerId };
    case "webhook": {
      const url = URL.canParse(target.url) ? new URL(target.url) : null;
      return {
        type: target.type,
        url: url === null ? "[invalid]" : `${url.origin}${url.pathname}`,
        secretRef: "[redacted]",
      };
    }
    case "command":
      return { type: target.type, executable: target.executable, args: target.args.length };
  }
};

export const makeHookTargets = Effect.gen(function* () {
  const inbox = yield* OrchestratorInbox.OrchestratorInbox;
  const policy = yield* HookTargetPolicy.HookTargetPolicy;
  const transport = yield* WebhookTransport.WebhookTransport;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcessEnvironment;

  const webhookUrl = (target: Extract<HookTarget, { type: "webhook" }>) => {
    if (!URL.canParse(target.url)) return "The webhook URL is not a valid URL.";
    const url = new URL(target.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "A webhook URL must use https or http.";
    }
    if (url.username !== "" || url.password !== "") {
      return "A webhook URL must not carry credentials. Use the signing secret instead.";
    }
    const isPrivate = policy.privateWebhookOrigins.includes(url.origin);
    if (!isPrivate && !policy.webhookOrigins.includes(url.origin)) {
      return `Webhooks to ${url.origin} are not allowed on this server. An operator allows an origin by listing it in T3CODE_HOOK_WEBHOOK_ORIGINS.`;
    }
    return { url, isPrivate };
  };

  const commandProblem = (target: Extract<HookTarget, { type: "command" }>) =>
    policy.commandExecutables.includes(target.executable)
      ? null
      : `Running ${target.executable} from a hook is not allowed on this server. An operator allows an executable by listing its absolute path in T3CODE_HOOK_COMMANDS.`;

  /** Checks a target against server policy when a hook is saved, and prepares what it needs. */
  const prepare = Effect.fn("HookTargets.prepare")(function* (target: HookTarget) {
    if (target.type === "webhook") {
      const checked = webhookUrl(target);
      if (typeof checked === "string") {
        return yield* automationError("PERMISSION_DENIED", checked);
      }
      if (!SECRET_REF_PATTERN.test(target.secretRef)) {
        return yield* automationError(
          "INVALID_INPUT",
          "secretRef must be a short name made of letters, digits, dots, dashes or underscores.",
        );
      }
      // The secret is created here so a receiver can be given it before the first delivery.
      yield* secrets
        .getOrCreateRandom(webhookSecretName(target.secretRef), WEBHOOK_SECRET_BYTES)
        .pipe(
          Effect.mapError(() =>
            automationError("INTERNAL", "The webhook signing secret could not be prepared."),
          ),
        );
    }
    if (target.type === "command") {
      const problem = commandProblem(target);
      if (problem !== null) return yield* automationError("PERMISSION_DENIED", problem);
    }
  });

  const sendWebhook = Effect.fnUntraced(function* (
    target: Extract<HookTarget, { type: "webhook" }>,
    payload: HookDeliveryPayload,
    body: string,
  ) {
    const checked = webhookUrl(target);
    if (typeof checked === "string") return yield* refused(checked);
    if (!checked.isPrivate) {
      const literal = literalAddress(checked.url);
      const addresses =
        literal === null
          ? yield* transport
              .resolve(checked.url.hostname)
              .pipe(Effect.mapError((error) => failed(error.reason)))
          : [literal];
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        return yield* refused(
          `${checked.url.hostname} resolves to a loopback, link-local or private address. An operator allows that by listing the origin in T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS.`,
        );
      }
    }
    const secret = yield* secrets
      .get(webhookSecretName(target.secretRef))
      .pipe(Effect.mapError(() => failed("The signing secret could not be read.")));
    if (Option.isNone(secret)) return yield* refused("The signing secret no longer exists.");

    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1_000));
    const response = yield* transport
      .post({
        url: checked.url.href,
        headers: {
          [WEBHOOK_HOOK_ID_HEADER]: payload.hookId,
          [WEBHOOK_DELIVERY_ID_HEADER]: payload.deliveryId,
          [WEBHOOK_DEDUP_KEY_HEADER]: payload.dedupKey,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook({
            secret: secret.value,
            timestamp,
            deliveryId: payload.deliveryId,
            body,
          }),
        },
        body,
      })
      .pipe(Effect.mapError((error) => failed(error.reason)));
    if (response.status >= 300 && response.status < 400) {
      // Following it would send the signed body somewhere policy never checked.
      return yield* refused(
        `The webhook answered with a redirect (HTTP ${response.status}), which is never followed.`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failed(`The webhook answered HTTP ${response.status}.`);
    }
  });

  const sendCommand = Effect.fnUntraced(function* (
    target: Extract<HookTarget, { type: "command" }>,
    body: string,
  ) {
    const problem = commandProblem(target);
    if (problem !== null) return yield* refused(problem);
    // Only the named variables reach the child. Nothing else is inherited.
    const env = Object.fromEntries(
      (target.envAllowlist ?? []).flatMap((name) => {
        const value = hostEnvironment[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    );
    const child = yield* spawner
      .spawn(
        ChildProcess.make(target.executable, target.args, {
          ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
          env,
          extendEnv: false,
          shell: false,
        }),
      )
      .pipe(Effect.mapError(() => failed(`${target.executable} could not be started.`)));
    const [stderr] = yield* Effect.all(
      [
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        Stream.runDrain(child.stdout),
        Stream.run(Stream.encodeText(Stream.make(body)), child.stdin),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => failed(`${target.executable} closed its pipes unexpectedly.`)));
    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(() => failed(`${target.executable} did not report an exit code.`)),
    );
    if (Number(exitCode) !== 0) {
      const detail = stderr.trim().slice(0, COMMAND_STDERR_LIMIT);
      return yield* failed(
        `${target.executable} exited with code ${exitCode}${detail === "" ? "." : `: ${detail}`}`,
      );
    }
  }, Effect.scoped);

  const relevance = (entries: ReadonlyArray<AutomationJournalEntry>) =>
    entries.every((entry) => INFORMATIONAL_EVENT_TYPES.has(entry.event.type))
      ? ("informational" as const)
      : ("actionable" as const);

  /** One attempt at handing the payload to the target. Succeeds only once the target has it. */
  const send = Effect.fn("HookTargets.send")(function* (
    target: HookTarget,
    payload: HookDeliveryPayload,
  ) {
    switch (target.type) {
      case "orchestrator_inbox":
        return yield* inbox
          .deliver({
            orchestratorId: target.orchestratorId,
            kind: "event",
            dedupKey: payload.dedupKey,
            relevance: relevance(payload.entries),
            entries: payload.entries,
            text: null,
            from: null,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError((error) =>
              // A missing or disabled orchestrator will not appear by retrying at once,
              // but it may be created later, so it stays a retryable failure.
              failed(`${error.code}: ${error.message}`),
            ),
          );
      case "cli_consumer":
        return;
      case "webhook":
      case "command": {
        const body = yield* encodePayload(payload).pipe(
          Effect.mapError(() => refused("The delivery payload could not be encoded.")),
        );
        return yield* target.type === "webhook"
          ? sendWebhook(target, payload, body)
          : sendCommand(target, body);
      }
    }
  });

  return { prepare, send };
});
