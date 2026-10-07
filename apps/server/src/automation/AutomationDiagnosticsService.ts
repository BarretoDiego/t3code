import type {
  AutomationDiagnostics,
  AutomationError,
  AutomationPendingWork,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { unsupported } from "./Caller.ts";

/** Health and backlog of the automation runtime, for `t3 doctor` and `t3 status`. */
export class AutomationDiagnosticsService extends Context.Service<
  AutomationDiagnosticsService,
  {
    readonly read: Effect.Effect<AutomationDiagnostics, AutomationError>;
    readonly pendingWork: Effect.Effect<AutomationPendingWork, AutomationError>;
  }
>()("t3/automation/AutomationDiagnosticsService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(AutomationDiagnosticsService, {
  read: Effect.fail(unsupported("AutomationDiagnosticsService")),
  pendingWork: Effect.fail(unsupported("AutomationDiagnosticsService")),
});
