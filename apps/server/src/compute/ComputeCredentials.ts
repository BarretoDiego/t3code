import { ComputeError, type ComputeProviderConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

/**
 * Native drivers call this for each credential refresh, never copy its result
 * into public state. Undefined delegates authentication to the SDK's ambient
 * workload identity. Only the dedicated compute secret namespace is accessible.
 */
export const resolveComputeCredential = Effect.fn("resolveComputeCredential")(function* (
  provider: ComputeProviderConfig,
) {
  const auth = provider.authentication;
  if (!auth || auth.type === "workload-identity") return undefined;
  if (!("secretRef" in auth) || !/^[a-zA-Z0-9_-]{1,128}$/.test(auth.secretRef))
    return yield* new ComputeError({
      code: "invalid-secret-ref",
      message: "Invalid compute credential reference.",
    });
  const store = yield* ServerSecretStore;
  const secret = yield* store.get(`compute-${auth.secretRef}`).pipe(
    Effect.mapError(
      () =>
        new ComputeError({
          code: "credential-unavailable",
          message: "Could not read compute credentials.",
        }),
    ),
  );
  if (Option.isNone(secret))
    return yield* new ComputeError({
      code: "credential-unavailable",
      message: "Compute credential reference was not found.",
    });
  return Redacted.make(secret.value);
});
