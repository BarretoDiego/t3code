import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * What hook targets beyond the inbox and CLI consumers this server allows.
 * Both lists are empty unless the operator sets them, so webhooks and commands
 * are off by default and no hook, event or agent can widen them.
 *
 * - `T3CODE_HOOK_WEBHOOK_ORIGINS`: origins a webhook may post to, comma
 *   separated, e.g. `https://hooks.example.com`. The host must resolve to
 *   public addresses.
 * - `T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS`: origins allowed even though they
 *   resolve to loopback, link-local or private addresses, e.g.
 *   `http://127.0.0.1:8787`.
 * - `T3CODE_HOOK_COMMANDS`: absolute paths of executables a command hook may
 *   run, comma separated.
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
  Effect.map(HostProcessEnvironment, (environment) => ({
    webhookOrigins: origins(environment.T3CODE_HOOK_WEBHOOK_ORIGINS),
    privateWebhookOrigins: origins(environment.T3CODE_HOOK_WEBHOOK_PRIVATE_ORIGINS),
    commandExecutables: list(environment.T3CODE_HOOK_COMMANDS),
  })),
);
