import type {
  AutomationError,
  ClaimTransferInput,
  PendingRequestSummary,
  PendingRequestsListInput,
  RequestRespondInput,
  RequestRespondResult,
  ResponsibilityClaim,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/** Decides who owns a pending request or task, and admits only the owner's answer. */
export class ResponsibilityService extends Context.Service<
  ResponsibilityService,
  {
    readonly listRequests: (
      caller: AutomationCaller,
      input: PendingRequestsListInput,
    ) => Effect.Effect<ReadonlyArray<PendingRequestSummary>, AutomationError>;
    readonly respond: (
      caller: AutomationCaller,
      input: RequestRespondInput,
    ) => Effect.Effect<RequestRespondResult, AutomationError>;
    readonly transferClaim: (
      caller: AutomationCaller,
      input: ClaimTransferInput,
    ) => Effect.Effect<ResponsibilityClaim, AutomationError>;
  }
>()("t3/automation/ResponsibilityService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(ResponsibilityService, {
  listRequests: () => Effect.fail(unsupported("ResponsibilityService")),
  respond: () => Effect.fail(unsupported("ResponsibilityService")),
  transferClaim: () => Effect.fail(unsupported("ResponsibilityService")),
});
