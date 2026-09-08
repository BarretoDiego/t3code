import type {
  OrchestrationClientOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { EventId, OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import { makeBarrierStream } from "@t3tools/shared/BarrierStream";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { makeHandoffJournal } from "../../handoff/HandoffJournal.ts";
import { committedOwner } from "../../handoff/lifecycle.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../ThreadBackgroundLiveness.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandIdConflictError = Schema.is(OrchestrationCommandIdConflictError);

interface CommandEnvelope {
  command: OrchestrationCommand;
  origin: OrchestrationClientOrigin | undefined;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;
  const crypto = yield* Crypto.Crypto;
  const handoffJournal = yield* makeHandoffJournal;
  const providerSessionRuntime = yield* ProviderSessionRuntime.make;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const mutationMutex = yield* Semaphore.make(1);
  const eventPubSub = yield* makeBarrierStream<OrchestrationEvent>();

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* eventPubSub.publish(persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          // A receipt only proves this exact command was handled. Replaying it
          // for a command aimed at another aggregate would report success for
          // work that never happened.
          if (
            existingReceipt.value.aggregateKind !== aggregateRef.aggregateKind ||
            existingReceipt.value.aggregateId !== aggregateRef.aggregateId
          ) {
            return yield* new OrchestrationCommandIdConflictError({
              commandId: envelope.command.commandId,
              receiptAggregateKind: existingReceipt.value.aggregateKind,
              receiptAggregateId: existingReceipt.value.aggregateId,
              commandAggregateKind: aggregateRef.aggregateKind,
              commandAggregateId: aggregateRef.aggregateId,
            });
          }
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        if ("threadId" in envelope.command) {
          const handoff = yield* handoffJournal.head(envelope.command.threadId).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Could not verify thread execution ownership.",
                  cause,
                }),
            ),
          );
          if (handoff) {
            const localEnvironmentId = handoff.localEnvironmentId ?? handoff.owner.environmentId;
            const frozen = [
              "checkpointing",
              "syncingProjects",
              "transferringSession",
              "verifying",
              "ready",
              "rollingBack",
            ].includes(handoff.phase);
            const moved = committedOwner(handoff).environmentId !== localEnvironmentId;
            // While pausing, existing provider/checkpoint work must settle before
            // the snapshot is frozen. Client edits and new turns cannot enter.
            const canDrain =
              envelope.command.type === "thread.turn.interrupt" ||
              envelope.command.type === "thread.session.stop" ||
              (envelope.origin === undefined &&
                [
                  "thread.session.set",
                  "thread.message.assistant.delta",
                  "thread.message.assistant.complete",
                  "thread.proposed-plan.upsert",
                  "thread.turn.diff.complete",
                  "thread.activity.append",
                  "thread.revert.complete",
                  "thread.title.regeneration.complete",
                ].includes(envelope.command.type));
            if (frozen || moved || (handoff.phase === "pausing" && !canDrain)) {
              return yield* new OrchestrationCommandInvariantError({
                commandType: envelope.command.type,
                detail: moved
                  ? "Thread execution belongs to another environment."
                  : "Thread mutations are frozen while its execution environment is transferring.",
              });
            }
          }
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} changed before automatic settlement`,
          });
        }

        // The decider compares the lookup inputs. Only recreation needs an
        // event check, since it can reset a thread to the same field values.
        if (
          envelope.command.type === "thread.pull-request.sync" &&
          (yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: envelope.command.threadId,
            sequenceExclusive: envelope.command.snapshotSequence,
            type: "thread.created",
          }))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} was recreated before pull request discovery`,
          });
        }

        if (
          envelope.command.type === "thread.auto-settle" &&
          threadBackgroundLiveness.getThreadBackgroundLiveness(envelope.command.threadId) !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: envelope.command.type,
            detail: `thread ${envelope.command.threadId} has live background work`,
          });
        }

        // Command snapshots omit activities at startup and cap them while running.
        // Read this request's durable state before deciding how to send the answer.
        const userInputActivity =
          envelope.command.type === "thread.user-input.respond" ||
          envelope.command.type === "thread.user-input.dismiss"
            ? yield* projectionSnapshotQuery.getUserInputActivity(envelope.command)
            : Option.none();
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
          ...(Option.isSome(userInputActivity)
            ? { userInputActivity: userInputActivity.value }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandRejection(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const plannedEvents = Array.isArray(eventBase) ? eventBase : [eventBase];
        // Stamp the dispatching client's origin onto every event the command
        // produced. The decider stays pure; attribution is an engine concern.
        const eventBases =
          envelope.origin === undefined
            ? plannedEvents
            : plannedEvents.map((planned) => ({
                ...planned,
                metadata: { ...planned.metadata, origin: envelope.origin },
              }));
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              const attachmentCleanups: Effect.Effect<void>[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                const cleanup = yield* projectionPipeline.projectEventDeferred(savedEvent);
                attachmentCleanups.push(cleanup);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                attachmentCleanups,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const cleanup of committedCommand.attachmentCleanups) {
          yield* cleanup;
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* eventPubSub.publish(event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            !isOrchestrationCommandPreviouslyRejectedError(error) &&
            !isOrchestrationCommandIdConflictError(error)
          ) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            if (isOrchestrationCommandRejection(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(
    Queue.take(commandQueue).pipe(
      Effect.flatMap((envelope) =>
        mutationMutex.withPermits(1)(Effect.suspend(() => processEnvelope(envelope))),
      ),
    ),
  );
  yield* Effect.forkScoped(worker);
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  const readThreadEvents: OrchestrationEngineShape["readThreadEvents"] = ({ threadId, ...range }) =>
    eventStore.readAggregateRange({ ...range, aggregateKind: "thread", aggregateId: threadId });

  const getThreadReplayStats: OrchestrationEngineShape["getThreadReplayStats"] = ({
    threadId,
    ...range
  }) =>
    eventStore.getAggregateReplayStats({
      ...range,
      aggregateKind: "thread",
      aggregateId: threadId,
    });

  const dispatch: OrchestrationEngineShape["dispatch"] = (command, options) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        origin: options?.origin,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  const importHandoffEvents: NonNullable<OrchestrationEngineShape["importHandoffEvents"]> = (
    input,
  ) =>
    mutationMutex.withPermits(1)(
      Effect.gen(function* () {
        const reject = (detail: string) =>
          new OrchestrationCommandInvariantError({ commandType: "thread.handoff.import", detail });
        const first = input.events[0];
        if (first?.type !== "thread.created") {
          return yield* reject("Handoff history must begin with thread.created.");
        }
        let previousSequence = -1;
        for (const event of input.events) {
          if (
            event.aggregateKind !== "thread" ||
            event.aggregateId !== input.threadId ||
            !("threadId" in event.payload) ||
            event.payload.threadId !== input.threadId ||
            event.metadata.historyImport !== true ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= previousSequence
          ) {
            return yield* reject(
              "Handoff history must be ordered, marked as imported, and belong to one thread.",
            );
          }
          previousSequence = event.sequence;
        }
        if (
          !commandReadModel.projects.some(
            (project) => project.id === first.payload.projectId && project.deletedAt === null,
          )
        ) {
          return yield* reject("Destination project does not exist.");
        }
        const occurredAt = yield* nowIso;
        const eventId = EventId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationCommandInvariantError({
                  commandType: "thread.handoff.import",
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
            ),
          ),
        );
        const committed = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (input.handoff) {
                const { record, runtime } = input.handoff;
                if (
                  record.owner.threadId !== input.threadId ||
                  runtime.threadId !== input.threadId ||
                  record.localEnvironmentId !== record.destinationEnvironmentId ||
                  record.owner.environmentId === record.destinationEnvironmentId ||
                  (record.phase !== "committed" && record.phase !== "completed") ||
                  runtime.providerInstanceId === null ||
                  runtime.resumeCursor === null ||
                  (runtime.executionFence !== undefined &&
                    (runtime.executionFence.handoffId !== record.handoffId ||
                      runtime.executionFence.owner.threadId !== input.threadId ||
                      runtime.executionFence.owner.environmentId !== record.owner.environmentId ||
                      runtime.executionFence.owner.generation !== record.owner.generation ||
                      runtime.executionFence.destinationEnvironmentId !==
                        record.destinationEnvironmentId))
                )
                  return yield* reject(
                    "Handoff runtime and execution ownership identities do not match.",
                  );
                const current = yield* handoffJournal.head(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationCommandInvariantError({
                        commandType: "thread.handoff.import",
                        detail: "Could not verify reserved ownership.",
                        cause,
                      }),
                  ),
                );
                if (
                  !current ||
                  current.handoffId !== record.handoffId ||
                  current.owner.environmentId !== record.owner.environmentId ||
                  current.owner.generation !== record.owner.generation ||
                  current.localEnvironmentId !== record.localEnvironmentId ||
                  current.destinationEnvironmentId !== record.destinationEnvironmentId
                )
                  return yield* reject("Handoff no longer matches the destination reservation.");
                if (current.phase === "committed" || current.phase === "completed") {
                  const binding = yield* providerSessionRuntime.getByThreadId({
                    threadId: input.threadId,
                  });
                  const existing = commandReadModel.threads.find(
                    (thread) => thread.id === input.threadId && thread.deletedAt === null,
                  );
                  if (
                    !existing ||
                    Option.isNone(binding) ||
                    binding.value.providerName !== runtime.providerName ||
                    binding.value.providerInstanceId !== runtime.providerInstanceId
                  ) {
                    return yield* reject(
                      "Committed handoff is missing its matching thread or provider binding.",
                    );
                  }
                  return {
                    nextReadModel: commandReadModel,
                    notification: null,
                    sequence: commandReadModel.snapshotSequence,
                  };
                }
                if (current.phase !== "preflighting")
                  return yield* reject("Destination reservation is no longer activatable.");
                if (
                  Option.isSome(
                    yield* providerSessionRuntime.getByThreadId({ threadId: input.threadId }),
                  )
                ) {
                  return yield* reject(
                    "Destination provider binding already exists; reverse handoff replacement is not supported yet.",
                  );
                }
              }
              if (
                commandReadModel.threads.some(
                  (thread) =>
                    thread.id === input.threadId &&
                    (input.handoff !== undefined || thread.deletedAt === null),
                )
              ) {
                // Replacing an earlier departure must reset every projection and
                // preserve replay semantics. Until that operation is explicit,
                // returning handoffs cannot overwrite an existing thread.
                return yield* reject(
                  "Destination thread already exists; reverse handoff replacement is not supported yet.",
                );
              }
              let nextReadModel = commandReadModel;
              for (const event of input.events) {
                const saved = yield* eventStore.append(event);
                nextReadModel = yield* projectEvent(nextReadModel, saved);
                // Historical revert/delete cleanups refer to the source timeline. Running
                // them here could delete attachments already restored for the final state.
                yield* projectionPipeline.projectEventDeferred(saved).pipe(Effect.asVoid);
              }
              const restored = nextReadModel.threads.find((thread) => thread.id === input.threadId);
              if (!restored || restored.deletedAt !== null) {
                return yield* reject("Handoff history must restore a live thread.");
              }
              if (
                !nextReadModel.projects.some(
                  (project) => project.id === restored.projectId && project.deletedAt === null,
                )
              ) {
                return yield* reject("Restored thread references an unavailable project.");
              }
              if (input.handoff) {
                const { record, runtime } = input.handoff;
                if (
                  restored.modelSelection.instanceId !== runtime.providerInstanceId ||
                  restored.runtimeMode !== runtime.runtimeMode ||
                  (restored.session !== null &&
                    (restored.session.threadId !== input.threadId ||
                      restored.session.providerName !== runtime.providerName ||
                      (restored.session.providerInstanceId !== undefined &&
                        restored.session.providerInstanceId !== runtime.providerInstanceId)))
                ) {
                  return yield* reject(
                    "Imported thread and provider runtime identities do not match.",
                  );
                }
                yield* handoffJournal.acceptIncoming(record).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationCommandInvariantError({
                        commandType: "thread.handoff.import",
                        detail: "Could not commit destination ownership.",
                        cause,
                      }),
                  ),
                );
                yield* providerSessionRuntime.upsert(runtime);
              }
              const notification = yield* eventStore.append({
                eventId,
                aggregateKind: "thread",
                aggregateId: input.threadId,
                occurredAt,
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "thread.meta-updated",
                payload: { threadId: input.threadId, updatedAt: restored.updatedAt },
              });
              nextReadModel = yield* projectEvent(nextReadModel, notification);
              yield* projectionPipeline.projectEventDeferred(notification).pipe(Effect.asVoid);
              return { nextReadModel, notification, sequence: notification.sequence };
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.importHandoffEvents:transaction")(error),
              ),
            ),
          );
        commandReadModel = committed.nextReadModel;
        if (committed.notification !== null) yield* eventPubSub.publish(committed.notification);
        return { sequence: committed.sequence };
      }).pipe(Effect.uninterruptible),
    );

  return {
    readEvents,
    readThreadEvents,
    getThreadReplayStats,
    dispatch,
    importHandoffEvents,
    subscribeDomainEvents: eventPubSub.subscribeUntracked,
    subscribeHandoffEvents: eventPubSub.subscribe,
    flushEvents: eventPubSub.flush,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return eventPubSub.stream;
    },
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
