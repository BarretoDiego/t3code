import {
  SourceControlAccountConfig,
  SourceControlRepositoryMapping,
  type SourceControlRepositoryMappingInput,
  SourceControlHubError,
  type SourceControlAccount,
  type SourceControlAccountSaveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const StoredAccount = Schema.Struct({ ...SourceControlAccountConfig.fields, token: Schema.String });
type StoredAccount = typeof StoredAccount.Type;
const decodeStoredAccount = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAccount));
const encodeStoredAccount = Schema.encodeEffect(Schema.fromJsonString(StoredAccount));
const decodeMappings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(SourceControlRepositoryMapping)),
);
const encodeMappings = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(SourceControlRepositoryMapping)),
);
type Provider = SourceControlAccount["provider"];
const failure = () =>
  new SourceControlHubError({ message: "Could not access source control account settings." });

export class SourceControlAccounts extends Context.Service<
  SourceControlAccounts,
  {
    readonly mappings: Effect.Effect<
      readonly SourceControlRepositoryMapping[],
      SourceControlHubError
    >;
    readonly saveMapping: (
      input: SourceControlRepositoryMappingInput,
    ) => Effect.Effect<void, SourceControlHubError>;
    readonly list: Effect.Effect<readonly SourceControlAccount[], SourceControlHubError>;
    readonly save: (
      input: SourceControlAccountSaveInput,
    ) => Effect.Effect<void, SourceControlHubError>;
    readonly remove: (provider: Provider) => Effect.Effect<void, SourceControlHubError>;
    /** Server transport use only. Never include this value in RPC results or agent context. */
    readonly credential: (
      provider: Provider,
    ) => Effect.Effect<StoredAccount | undefined, SourceControlHubError>;
  }
>()("t3/sourceControl/SourceControlAccounts") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const gate = yield* Semaphore.make(1);
  const key = (provider: Provider) => `source-control-account-${provider}`;
  const credential = Effect.fn(function* (provider: Provider) {
    const bytes = yield* secrets.get(key(provider));
    if (Option.isNone(bytes)) return undefined;
    return yield* decodeStoredAccount(new TextDecoder().decode(bytes.value));
  }, Effect.mapError(failure));
  const mappings = Effect.gen(function* () {
    const bytes = yield* secrets.get("source-control-repository-mappings");
    return Option.isNone(bytes) ? [] : yield* decodeMappings(new TextDecoder().decode(bytes.value));
  }).pipe(Effect.mapError(failure));
  return SourceControlAccounts.of({
    mappings,
    saveMapping: (input) =>
      gate
        .withPermit(
          Effect.gen(function* () {
            const current = (yield* mappings).filter(
              (mapping) =>
                mapping.projectId !== input.projectId || mapping.remoteName !== input.remoteName,
            );
            if (input.reference)
              current.push({
                projectId: input.projectId,
                remoteName: input.remoteName,
                reference: input.reference,
              });
            yield* secrets.set(
              "source-control-repository-mappings",
              new TextEncoder().encode(yield* encodeMappings(current)),
            );
          }),
        )
        .pipe(Effect.mapError(failure)),
    credential,
    list: Effect.all([credential("github"), credential("bitbucket")]).pipe(
      Effect.map((accounts) =>
        accounts.flatMap((account) =>
          account
            ? [
                {
                  provider: account.provider,
                  label: account.label,
                  username: account.username,
                  workspace: account.workspace,
                  hasCredential: account.token.length > 0,
                },
              ]
            : [],
        ),
      ),
    ),
    save: (input) =>
      gate
        .withPermit(
          Effect.gen(function* () {
            const previous = yield* credential(input.account.provider);
            const token = input.token ?? previous?.token ?? "";
            const encoded = yield* encodeStoredAccount({
              ...input.account,
              token,
            });
            yield* secrets.set(key(input.account.provider), new TextEncoder().encode(encoded));
          }),
        )
        .pipe(Effect.mapError(failure)),
    remove: (provider) =>
      gate.withPermit(secrets.remove(key(provider))).pipe(Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(SourceControlAccounts, make);
