import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AutomationEventFilter,
  type HookTarget,
  type HookUpsertInput,
  type InboxEntry,
  InboxEntryId,
  OrchestratorId,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { automationError } from "../Caller.ts";
import * as EventJournal from "../EventJournal.ts";
import { testEnvironmentLayer } from "../events/journal.testkit.ts";
import * as HookService from "../HookService.ts";
import * as OrchestratorInbox from "../OrchestratorInbox.ts";
import * as HookTargetPolicy from "./HookTargetPolicy.ts";
import * as WebhookTransport from "./WebhookTransport.ts";

export const ORCHESTRATOR_ID = OrchestratorId.make("orchestrator-main");

/**
 * Stands in for the orchestrator inbox table. It outlives a layer so a test
 * can rebuild the runtime on the same database and see what the inbox holds.
 */
interface InboxState {
  /** Stored entries by `orchestratorId:dedupKey`: one per logical delivery. */
  readonly entries: Map<string, InboxEntry>;
  /** Dedup key of every call, in order, including repeats and failures. */
  readonly calls: Array<string>;
  /** What the next calls do instead of succeeding. Consumed front to back. */
  readonly script: Array<"fail" | "store-then-fail" | "hang">;
  /** Runs after an entry is stored. Lets a test react to a delivery. */
  onDelivered: (entry: InboxEntry) => Effect.Effect<void>;
  /** Runs when a call starts, before the script decides its outcome. */
  onCall: (dedupKey: string) => Effect.Effect<void>;
}

export const makeInboxState = (): InboxState => ({
  entries: new Map(),
  calls: [],
  script: [],
  onDelivered: () => Effect.void,
  onCall: () => Effect.void,
});

const inboxLayer = (state: InboxState) =>
  Layer.succeed(OrchestratorInbox.OrchestratorInbox, {
    deliver: Effect.fnUntraced(function* (input) {
      state.calls.push(input.dedupKey);
      yield* state.onCall(input.dedupKey);
      const step = state.script.shift();
      if (step === "hang") return yield* Effect.never;
      if (step === "fail") {
        return yield* automationError("INTERNAL", "The inbox is unavailable.");
      }
      const key = `${input.orchestratorId}:${input.dedupKey}`;
      const existing = state.entries.get(key);
      const entry: InboxEntry = existing ?? {
        id: InboxEntryId.make(`inbox-${state.entries.size + 1}`),
        status: "pending",
        reservedByRunId: null,
        receivedAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        ...input,
      };
      state.entries.set(key, entry);
      if (existing === undefined) yield* state.onDelivered(entry);
      if (step === "store-then-fail") {
        // The row was written but the acknowledgement was lost.
        return yield* automationError("INTERNAL", "The inbox answered too late.");
      }
      return { entry, created: existing === undefined };
    }),
  });

/** What the webhook transport double saw and how it answers. */
interface WebhookState {
  readonly requests: Array<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }>;
  readonly resolved: Array<string>;
  addresses: ReadonlyArray<string>;
  response: { readonly status: number; readonly location: string | null };
}

export const makeWebhookState = (): WebhookState => ({
  requests: [],
  resolved: [],
  addresses: ["93.184.216.34"],
  response: { status: 200, location: null },
});

const webhookLayer = (state: WebhookState) =>
  Layer.succeed(WebhookTransport.WebhookTransport, {
    resolve: (hostname) =>
      Effect.sync(() => {
        state.resolved.push(hostname);
        return state.addresses;
      }),
    post: (request) =>
      Effect.sync(() => {
        state.requests.push(request);
        return state.response;
      }),
  });

/** Secrets kept in memory for the life of one test. */
const makeSecretsLayer = (secrets = new Map<string, Uint8Array>()) =>
  Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing !== undefined) return existing;
        const created = new Uint8Array(bytes).fill(7);
        secrets.set(name, created);
        return created;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });

export interface HookTestOptions {
  readonly inbox?: InboxState;
  readonly webhook?: WebhookState;
  readonly policy?: Partial<HookTargetPolicy.HookTargetPolicy["Service"]>;
  readonly secrets?: Map<string, Uint8Array>;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Hooks, the journal and the delivery runtime over the given database, with
 * doubles at the boundaries hooks reach across: the inbox, the network, the
 * secret store.
 */
export const makeHookTestLayerOn = <E>(
  database: Layer.Layer<SqlClient.SqlClient, E, FileSystem.FileSystem | Path.Path>,
  options: HookTestOptions = {},
) =>
  HookService.layerWithoutTargetPolicy.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        inboxLayer(options.inbox ?? makeInboxState()),
        webhookLayer(options.webhook ?? makeWebhookState()),
        makeSecretsLayer(options.secrets),
        Layer.succeed(HookTargetPolicy.HookTargetPolicy, {
          webhookOrigins: [],
          privateWebhookOrigins: [],
          commandExecutables: [],
          ...options.policy,
        }),
        Layer.succeed(HostProcessEnvironment, options.environment ?? {}),
      ),
    ),
    Layer.provideMerge(EventJournal.layer),
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(testEnvironmentLayer),
  );

/** The same over a private in-memory database. */
export const makeHookTestLayer = (options: HookTestOptions = {}) =>
  makeHookTestLayerOn(Layer.fresh(SqlitePersistenceMemory), options);

const inboxTarget: HookTarget = {
  type: "orchestrator_inbox",
  orchestratorId: ORCHESTRATOR_ID,
};

/** A hook definition with sensible defaults; a test names only what it is about. */
export const hookInput = (
  overrides: Partial<HookUpsertInput> & { readonly filter?: AutomationEventFilter } = {},
): HookUpsertInput => ({
  name: "test hook",
  enabled: true,
  filter: {},
  target: inboxTarget,
  deliveryMode: "each",
  retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 4_000 },
  timeoutMs: 5_000,
  priority: 0,
  ...overrides,
});
