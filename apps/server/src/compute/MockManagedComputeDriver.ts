import { ComputeError, type GenerationJob } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ManagedComputeDriver, ManagedComputeOperation } from "./ManagedComputeProvider.ts";

/** Simulated external service. Keep this driver when recreating an adapter in restart tests. */
export function makeMockManagedComputeDriver(): ManagedComputeDriver {
  const operations = new Map<string, { job: GenerationJob; started: number; cancelled: boolean }>();
  return {
    type: "mock-managed",
    connect: (provider) =>
      Effect.sync(() => {
        const key = (id: string) => `${provider.id.length}:${provider.id}${id}`;
        const get = Effect.fn("MockManagedComputeDriver.get")(function* (id: string) {
          const entry = operations.get(key(id));
          if (!entry)
            return yield* new ComputeError({
              code: "operation-not-found",
              message: "Simulated remote operation not found.",
            });
          const elapsed = (yield* Clock.currentTimeMillis) - entry.started;
          const completed = elapsed >= 2000;
          return {
            id,
            status: entry.cancelled ? "cancelled" : completed ? "completed" : "running",
            progress: entry.cancelled ? 0 : Math.min(100, Math.floor(elapsed / 20)),
            startedAt: DateTime.formatIso(DateTime.makeUnsafe(entry.started)),
            ...(entry.cancelled || completed
              ? {
                  completedAt: DateTime.formatIso(
                    DateTime.makeUnsafe(entry.started + Math.min(elapsed, 2000)),
                  ),
                }
              : {}),
            ...(completed && !entry.cancelled
              ? {
                  outputs: [
                    {
                      id: `${entry.job.id}-output`,
                      uri: "data:application/json;base64,e30=",
                      mimeType: "application/json",
                      name: "mock-managed-result.json",
                    },
                  ],
                }
              : {}),
          } satisfies ManagedComputeOperation;
        });
        return {
          close: Effect.void,
          health: Effect.succeed({ status: "online" as const }),
          discover: Effect.succeed({
            capabilities: [
              {
                id: "document.generate",
                category: "document",
                operations: ["generate"],
                models: [
                  {
                    id: "mock-managed-v1",
                    name: "Simulated managed model",
                    status: "available" as const,
                    operations: ["generate"],
                  },
                ],
              },
            ],
          }),
          submit: Effect.fn("MockManagedComputeDriver.submit")(function* (job) {
            const id = `operations/${job.id}`;
            if (!operations.has(key(id)))
              operations.set(key(id), {
                job,
                started: yield* Clock.currentTimeMillis,
                cancelled: false,
              });
            return yield* get(id);
          }),
          get,
          findByRequestId: (id) =>
            Effect.suspend(() =>
              operations.has(key(`operations/${id}`))
                ? get(`operations/${id}`)
                : Effect.succeed(undefined),
            ),
          cancel: (id) =>
            Effect.sync(() => {
              const entry = operations.get(key(id));
              if (entry) entry.cancelled = true;
            }),
        };
      }),
  };
}
