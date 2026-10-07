import type {
  AutomationError,
  InboxEntry,
  Orchestrator,
  OrchestratorCheckpoint,
  OrchestratorHandoff,
  OrchestratorId,
  OrchestratorSendInput,
  OrchestratorSendResult,
  OrchestratorSetStateInput,
  OrchestratorUpsertInput,
  OrchestratorsHandoffInput,
  OrchestratorsInboxInput,
  OrchestratorsResolveInboxInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/** Persistent orchestrators: identity, inbox, turns, checkpoints, and hosting. */
export class OrchestratorService extends Context.Service<
  OrchestratorService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Orchestrator>, AutomationError>;
    readonly subscribe: (
      caller: AutomationCaller,
    ) => Stream.Stream<ReadonlyArray<Orchestrator>, AutomationError>;
    readonly upsert: (
      caller: AutomationCaller,
      input: OrchestratorUpsertInput,
    ) => Effect.Effect<Orchestrator, AutomationError>;
    readonly setState: (
      caller: AutomationCaller,
      input: OrchestratorSetStateInput,
    ) => Effect.Effect<Orchestrator, AutomationError>;
    readonly delete: (
      caller: AutomationCaller,
      input: OrchestratorId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly send: (
      caller: AutomationCaller,
      input: OrchestratorSendInput,
    ) => Effect.Effect<OrchestratorSendResult, AutomationError>;
    readonly inbox: (
      caller: AutomationCaller,
      input: OrchestratorsInboxInput,
    ) => Effect.Effect<ReadonlyArray<InboxEntry>, AutomationError>;
    readonly resolveInbox: (
      caller: AutomationCaller,
      input: OrchestratorsResolveInboxInput,
    ) => Effect.Effect<InboxEntry, AutomationError>;
    readonly checkpoints: (
      caller: AutomationCaller,
      input: { readonly orchestratorId: OrchestratorId; readonly limit?: number | undefined },
    ) => Effect.Effect<ReadonlyArray<OrchestratorCheckpoint>, AutomationError>;
    readonly handoff: (
      caller: AutomationCaller,
      input: OrchestratorsHandoffInput,
    ) => Effect.Effect<OrchestratorHandoff, AutomationError>;
    readonly handoffStatus: (
      caller: AutomationCaller,
      input: OrchestratorId,
    ) => Effect.Effect<OrchestratorHandoff | null, AutomationError>;
  }
>()("t3/automation/OrchestratorService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(OrchestratorService, {
  list: () => Effect.fail(unsupported("OrchestratorService")),
  subscribe: () => Stream.fail(unsupported("OrchestratorService")),
  upsert: () => Effect.fail(unsupported("OrchestratorService")),
  setState: () => Effect.fail(unsupported("OrchestratorService")),
  delete: () => Effect.fail(unsupported("OrchestratorService")),
  send: () => Effect.fail(unsupported("OrchestratorService")),
  inbox: () => Effect.fail(unsupported("OrchestratorService")),
  resolveInbox: () => Effect.fail(unsupported("OrchestratorService")),
  checkpoints: () => Effect.fail(unsupported("OrchestratorService")),
  handoff: () => Effect.fail(unsupported("OrchestratorService")),
  handoffStatus: () => Effect.fail(unsupported("OrchestratorService")),
});
