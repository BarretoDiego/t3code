import { SourceControlHubError, type SourceControlAccountConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const Identity = Schema.Struct({
  login: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
});
const decodeIdentity = Schema.decodeUnknownEffect(Identity);

/** Verify read access without requiring user-profile scopes on repository integration tokens. */
export function verifySourceControlCredential(
  account: SourceControlAccountConfig,
  token: string,
  request: typeof fetch = fetch,
) {
  return Effect.gen(function* () {
    const github = account.provider === "github";
    const workspace = account.workspace.trim();
    const repository = account.repository?.trim();
    if (!github && !account.username.trim() && !workspace)
      return yield* new SourceControlHubError({
        message:
          "Enter the workspace for this integration token. For a repository token, enter its repository slug too.",
      });
    const authorization =
      github || !account.username.trim()
        ? `Bearer ${token}`
        : `Basic ${Buffer.from(`${account.username.trim()}:${token}`).toString("base64")}`;
    const get = (url: string) =>
      Effect.tryPromise({
        try: () =>
          request(url, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
              Accept: "application/json",
              "User-Agent": "T3-Code",
              Authorization: authorization,
            },
          }),
        catch: () =>
          new SourceControlHubError({
            message: "Could not reach the provider. Check network access and retry.",
          }),
      });
    const identityResponse =
      github || account.username.trim()
        ? yield* get(github ? "https://api.github.com/user" : "https://api.bitbucket.org/2.0/user")
        : null;
    if (identityResponse?.ok) {
      const body = yield* Effect.tryPromise({
        try: () => identityResponse.json() as Promise<unknown>,
        catch: () =>
          new SourceControlHubError({
            message: "The provider returned an invalid identity response.",
          }),
      });
      const identity = yield* decodeIdentity(body).pipe(
        Effect.mapError(
          () =>
            new SourceControlHubError({
              message: "The provider returned an invalid identity response.",
            }),
        ),
      );
      const accountName = identity.login ?? identity.display_name ?? identity.username;
      if (accountName) return { accountName };
    }
    if (identityResponse?.status === 401)
      return yield* new SourceControlHubError({
        message:
          "The provider rejected the credentials (401). Check the token type, email, expiration and token value.",
      });
    if (!github && workspace && (identityResponse === null || identityResponse.status === 403)) {
      const path = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}${repository ? `/${encodeURIComponent(repository)}` : "?pagelen=1"}`;
      const access = yield* get(path);
      if (access.ok) return { accountName: repository ? `${workspace}/${repository}` : workspace };
      return yield* new SourceControlHubError({
        message: `Bitbucket could not verify repository access (${access.status}). Check the workspace, repository slug and repository-read permission.`,
      });
    }
    return yield* new SourceControlHubError({
      message:
        "Authentication could not be verified. Check the token and account-read permission, or specify the Bitbucket workspace to verify repository access.",
    });
  });
}
