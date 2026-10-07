import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { SessionCredentialChange } from "./SessionStore.ts";

const missingScope = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    requiredScope,
  });

const revoked = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: "The authenticated session was revoked.",
    requiredScope,
  });

/**
 * Authorizes the calls of one connection. Scopes are read once when the socket
 * opens, so the gate also watches the session store: after the session is
 * revoked every new call is refused and every open subscription ends, even
 * though the socket itself is still connected.
 */
export const makeSessionGate = Effect.fn("makeSessionGate")(function* (input: {
  readonly sessionId: AuthSessionId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly changes: Stream.Stream<SessionCredentialChange>;
}) {
  const sessionRevoked = yield* Deferred.make<void>();
  const watching = yield* Deferred.make<void>();
  yield* input.changes.pipe(
    Stream.onStart(Deferred.succeed(watching, undefined)),
    Stream.filter(
      (change) => change.type === "clientRemoved" && change.sessionId === input.sessionId,
    ),
    Stream.take(1),
    Stream.runForEach(() => Deferred.succeed(sessionRevoked, undefined)),
    Effect.forkScoped,
  );
  // A revocation published before the watcher subscribed would be missed.
  yield* Deferred.await(watching);

  const authorizeEffect = <A, E, R>(
    requiredScope: AuthEnvironmentScope,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
    input.scopes.includes(requiredScope)
      ? Effect.flatMap(
          Deferred.isDone(sessionRevoked),
          (isRevoked): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
            isRevoked ? Effect.fail(revoked(requiredScope)) : effect,
        )
      : Effect.fail(missingScope(requiredScope));

  const authorizeStream = <A, E, R>(
    requiredScope: AuthEnvironmentScope,
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
    input.scopes.includes(requiredScope)
      ? Stream.unwrap(
          Effect.map(
            Deferred.isDone(sessionRevoked),
            (isRevoked): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
              isRevoked
                ? Stream.fail(revoked(requiredScope))
                : Stream.interruptWhen(stream, Deferred.await(sessionRevoked)),
          ),
        )
      : Stream.fail(missingScope(requiredScope));

  return { authorizeEffect, authorizeStream } as const;
});
