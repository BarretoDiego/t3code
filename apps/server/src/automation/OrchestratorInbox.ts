import type { AutomationError, InboxEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { unsupported } from "./Caller.ts";

export type OrchestratorInboxDelivery = Pick<
  InboxEntry,
  "orchestratorId" | "kind" | "dedupKey" | "relevance" | "entries" | "text" | "from"
>;

/**
 * The durable write side of an orchestrator's inbox. Hook delivery, peer
 * messages and user sends all land here; a delivery counts as made only once
 * `deliver` returns, which is after the row is committed.
 */
export class OrchestratorInbox extends Context.Service<
  OrchestratorInbox,
  {
    /** Idempotent on (orchestratorId, dedupKey): a repeat returns the stored entry with `created: false`. */
    readonly deliver: (
      input: OrchestratorInboxDelivery,
    ) => Effect.Effect<{ readonly entry: InboxEntry; readonly created: boolean }, AutomationError>;
  }
>()("t3/automation/OrchestratorInbox") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(OrchestratorInbox, {
  deliver: () => Effect.fail(unsupported("OrchestratorInbox")),
});
