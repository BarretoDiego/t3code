import { EnvironmentId, type AutomationEventType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { type AutomationCaller } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("env-local");

export const testEnvironmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(TEST_ENVIRONMENT_ID),
  getDescriptor: Effect.die(new Error("The environment descriptor is not used by these tests.")),
});

/** The journal over a private in-memory database. */
export const makeJournalTestLayer = () =>
  EventJournal.layer.pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provide(testEnvironmentLayer),
  );

export const testClient: AutomationCaller = {
  kind: "client",
  subject: "session-test",
  scopes: [],
};

/** A minimal event of the given type about one aggregate. */
export const testEvent = (
  type: AutomationEventType,
  overrides: Partial<EventJournal.EventJournalAppend> = {},
): EventJournal.EventJournalAppend => ({
  type,
  origin: { kind: "service" },
  scope: {},
  aggregate: { kind: "custom", id: "aggregate-1" },
  payload: {},
  ...overrides,
});
