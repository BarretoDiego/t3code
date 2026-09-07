import { SourceControlHubError, type SourceControlAccountConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const Identity = Schema.Struct({
  login: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});

/** Verify against the provider's fixed identity endpoint; response bodies never enter error messages. */
export function verifySourceControlCredential(
  account: SourceControlAccountConfig,
  token: string,
  request: typeof fetch = fetch,
) {
  return Effect.tryPromise({
    try: async () => {
      const github = account.provider === "github";
      const response = await request(
        github ? "https://api.github.com/user" : "https://api.bitbucket.org/2.0/user",
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            Accept: "application/json",
            "User-Agent": "T3-Code",
            Authorization:
              github || !account.username
                ? `Bearer ${token}`
                : `Basic ${Buffer.from(`${account.username}:${token}`).toString("base64")}`,
          },
        },
      );
      if (!response.ok) throw new Error("Credential check failed");
      return (await response.json()) as unknown;
    },
    catch: () =>
      new SourceControlHubError({
        message:
          "Authentication could not be verified. Check the token, account and required permissions.",
      }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Identity)),
    Effect.flatMap((identity) => {
      const accountName = identity.login ?? identity.display_name ?? identity.username;
      return accountName
        ? Effect.succeed({ accountName })
        : Effect.fail(
            new SourceControlHubError({
              message: "The provider did not return an account identity.",
            }),
          );
    }),
    Effect.mapError(
      () =>
        new SourceControlHubError({
          message:
            "Authentication could not be verified. Check the token, account and required permissions.",
        }),
    ),
  );
}
