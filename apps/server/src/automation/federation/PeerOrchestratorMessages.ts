import type { AutomationError, EnvironmentId, PeerMessage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { unsupported } from "../Caller.ts";

type OrchestratorPeerMessage = PeerMessage & {
  readonly body: Extract<
    PeerMessage["body"],
    { readonly type: "orchestrator.send" | "orchestrator.projection" | "orchestrator.handoff" }
  >;
};

/**
 * Where a peer's `orchestrator.send`, `orchestrator.projection` and
 * `orchestrator.handoff` messages go once they are stored, authenticated and
 * permitted. The orchestrator runtime replaces `layerUnsupported` with its own
 * handler; until then the sender gets `CAPABILITY_UNSUPPORTED` back instead of
 * silence.
 */
export class PeerOrchestratorMessages extends Context.Service<
  PeerOrchestratorMessages,
  {
    /** Must be idempotent on `message.messageId`: a crash after it ran replays the message. */
    readonly handle: (input: {
      readonly fromEnvironmentId: EnvironmentId;
      readonly message: OrchestratorPeerMessage;
    }) => Effect.Effect<void, AutomationError>;
  }
>()("t3/automation/federation/PeerOrchestratorMessages") {}

export const layerUnsupported = Layer.succeed(PeerOrchestratorMessages, {
  handle: ({ message }) => Effect.fail(unsupported(`Peer message ${message.body.type}`)),
});
