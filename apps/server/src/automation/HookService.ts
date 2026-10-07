import type {
  AutomationError,
  Hook,
  HookDelivery,
  HookDeliveryId,
  HookId,
  HookTestResult,
  HookUpsertInput,
  HooksDeliveriesInput,
  HooksTestInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type AutomationCaller, unsupported } from "./Caller.ts";

/** Persisted hook subscriptions and their deliveries. */
export class HookService extends Context.Service<
  HookService,
  {
    readonly list: (
      caller: AutomationCaller,
    ) => Effect.Effect<ReadonlyArray<Hook>, AutomationError>;
    readonly upsert: (
      caller: AutomationCaller,
      input: HookUpsertInput,
    ) => Effect.Effect<Hook, AutomationError>;
    readonly setEnabled: (
      caller: AutomationCaller,
      input: { readonly hookId: HookId; readonly enabled: boolean },
    ) => Effect.Effect<Hook, AutomationError>;
    readonly delete: (
      caller: AutomationCaller,
      input: HookId,
    ) => Effect.Effect<boolean, AutomationError>;
    readonly test: (
      caller: AutomationCaller,
      input: HooksTestInput,
    ) => Effect.Effect<HookTestResult, AutomationError>;
    readonly deliveries: (
      caller: AutomationCaller,
      input: HooksDeliveriesInput,
    ) => Effect.Effect<ReadonlyArray<HookDelivery>, AutomationError>;
    readonly redeliver: (
      caller: AutomationCaller,
      input: HookDeliveryId,
    ) => Effect.Effect<HookDelivery, AutomationError>;
    readonly dismissDelivery: (
      caller: AutomationCaller,
      input: HookDeliveryId,
    ) => Effect.Effect<HookDelivery, AutomationError>;
  }
>()("t3/automation/HookService") {}

// Replaced by the real implementation; until then every call reports the capability as absent.
export const layer = Layer.succeed(HookService, {
  list: () => Effect.fail(unsupported("HookService")),
  upsert: () => Effect.fail(unsupported("HookService")),
  setEnabled: () => Effect.fail(unsupported("HookService")),
  delete: () => Effect.fail(unsupported("HookService")),
  test: () => Effect.fail(unsupported("HookService")),
  deliveries: () => Effect.fail(unsupported("HookService")),
  redeliver: () => Effect.fail(unsupported("HookService")),
  dismissDelivery: () => Effect.fail(unsupported("HookService")),
});
