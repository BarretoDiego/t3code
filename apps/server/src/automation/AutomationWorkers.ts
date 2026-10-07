import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as AutomationLayer from "./AutomationLayer.ts";
import * as JournalRetention from "./events/JournalRetention.ts";
import * as FederationReactor from "./federation/FederationReactor.ts";
import * as PeerOrchestratorMessages from "./federation/PeerOrchestratorMessages.ts";
import * as PeerTransport from "./federation/PeerTransport.ts";
import * as HookRuntime from "./hooks/HookRuntime.ts";
import * as JobService from "./JobService.ts";
import * as SnoozeExpiry from "./tasks/SnoozeExpiry.ts";
import * as TaskReactor from "./tasks/TaskReactor.ts";

const federation = Layer.effectDiscard(
  Effect.flatMap(FederationReactor.FederationReactor, (reactor) => reactor.start()),
).pipe(
  Layer.provide(FederationReactor.layer),
  Layer.provide(PeerTransport.layer),
  Layer.provide(PeerOrchestratorMessages.layerUnsupported),
);

// Only the server process may run this: from a second process on the same
// database it would declare the server's live jobs lost.
const jobRecovery = Layer.effectDiscard(
  Effect.flatMap(JobService.JobRecovery, (recovery) => recovery.start()),
);

/**
 * Starts every automation worker with the server: hook delivery, journal
 * retention, the delegated-task reactor, snooze expiry, peer links and job
 * recovery. The orchestrator runtime starts with its own service layer.
 */
export const layer = Layer.mergeAll(
  HookRuntime.workerLive,
  JournalRetention.workerLive,
  TaskReactor.workerLayer,
  SnoozeExpiry.workerLayer,
  federation,
  jobRecovery,
).pipe(
  Layer.provide(AutomationLayer.layer),
  Layer.provide(Scheduler.layer),
  // The same layer value the orchestration runtime builds, so both read one live event feed.
  Layer.provide(OrchestrationV2EventSinkLayerLive),
);
