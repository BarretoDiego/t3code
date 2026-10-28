import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Operator allowlists for hook targets beyond the inbox and CLI consumers; empty by default, so no hook, event or agent can widen them.
 * `T3CODE_HOOK_WEBHOOK_ORIGINS`: comma-separated origins a webhook may post to; the host must resolve to public addresses.
 * `T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS`: origins allowed even when they resolve to loopback, link-local or private addresses.
 * `T3CODE_HOOK_COMMANDS`: comma-separated absolute paths of executables a command hook may run.
 */
export class HookTargetPolicy extends Context.Service<
  HookTargetPolicy,
  {
    readonly webhookOrigins: ReadonlyArray<string>;
    readonly privateWebhookOrigins: ReadonlyArray<string>;
    readonly commandExecutables: ReadonlyArray<string>;
  }
>()("t3/automation/hooks/HookTargetPolicy") {}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const origins = (value: string | undefined) =>
  list(value).flatMap((entry) => (URL.canParse(entry) ? [new URL(entry).origin] : []));

export const layer = Layer.effect(
  HookTargetPolicy,
  Effect.map(HostProcess.Environment, (environment) => ({
    webhookOrigins: origins(environment.T3CODE_HOOK_WEBHOOK_ORIGINS),
    privateWebhookOrigins: origins(environment.T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS),
    commandExecutables: list(environment.T3CODE_HOOK_COMMANDS),
  })),
);
