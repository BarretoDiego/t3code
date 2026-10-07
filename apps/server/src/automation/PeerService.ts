import type {
  AutomationError,
  EnvironmentId,
  Peer,
  PeerAddInput,
  PeerDeliverInput,
  PeerDeliverResult,
  PeerHelloInput,
  PeerHelloResult,
  PeerMessage,
  PeerMessageBody,
  PeerOutboxEntry,
  PeerUpdateInput,
  PeersOutboxInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type AutomationCaller, unsupported } from "./Caller.ts";

export interface PeerEnqueueInput {
  readonly toEnvironmentId: EnvironmentId;
  readonly body: PeerMessageBody;
  readonly correlationId: string;
  /** Stable key: enqueueing the same thing twice returns the first message. */
  readonly dedupKey: string;
  readonly expiresAt?: string | undefined;
}

/** Paired peer environments and the store-and-forward link to each. */
export class PeerService extends Context.Service<
  PeerService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Peer>, AutomationError>;
    readonly add: (
      caller: AutomationCaller,
      input: PeerAddInput,
    ) => Effect.Effect<Peer, AutomationError>;
    readonly update: (
      caller: AutomationCaller,
      input: PeerUpdateInput,
    ) => Effect.Effect<Peer, AutomationError>;
    readonly remove: (
      caller: AutomationCaller,
      input: EnvironmentId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly outbox: (
      caller: AutomationCaller,
      input: PeersOutboxInput,
    ) => Effect.Effect<ReadonlyArray<PeerOutboxEntry>, AutomationError>;
    readonly enqueue: (input: PeerEnqueueInput) => Effect.Effect<PeerMessage, AutomationError>;
    readonly hello: (
      caller: AutomationCaller,
      input: PeerHelloInput,
    ) => Effect.Effect<PeerHelloResult, AutomationError>;
    readonly deliver: (
      caller: AutomationCaller,
      input: PeerDeliverInput,
    ) => Effect.Effect<PeerDeliverResult, AutomationError>;
  }
>()("t3/automation/PeerService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(PeerService, {
  list: () => Effect.fail(unsupported("PeerService")),
  add: () => Effect.fail(unsupported("PeerService")),
  update: () => Effect.fail(unsupported("PeerService")),
  remove: () => Effect.fail(unsupported("PeerService")),
  outbox: () => Effect.fail(unsupported("PeerService")),
  enqueue: () => Effect.fail(unsupported("PeerService")),
  hello: () => Effect.fail(unsupported("PeerService")),
  deliver: () => Effect.fail(unsupported("PeerService")),
});
