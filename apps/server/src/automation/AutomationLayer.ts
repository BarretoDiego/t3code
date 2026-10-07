import * as Layer from "effect/Layer";

import * as AutomationDiagnosticsService from "./AutomationDiagnosticsService.ts";
import * as DelegatedTaskService from "./DelegatedTaskService.ts";
import * as EventJournal from "./EventJournal.ts";
import * as HookService from "./HookService.ts";
import * as JobService from "./JobService.ts";
import * as OrchestratorInbox from "./OrchestratorInbox.ts";
import * as OrchestratorService from "./OrchestratorService.ts";
import * as PeerService from "./PeerService.ts";
import * as ResponsibilityService from "./ResponsibilityService.ts";

/** Every automation service, for the server runtime and for tests that need the whole set. */
export const layer = Layer.mergeAll(
  EventJournal.layer,
  HookService.layer,
  ResponsibilityService.layer,
  OrchestratorService.layer,
  OrchestratorInbox.layer,
  DelegatedTaskService.layer,
  JobService.layer,
  PeerService.layer,
  AutomationDiagnosticsService.layer,
);

export type AutomationServices = Layer.Success<typeof layer>;
