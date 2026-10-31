import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SourceControlAccounts } from "./SourceControlAccounts.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { resolveSourceControlHostSecrets } from "./sourceControlHostSecrets.ts";

export const layer = Layer.effect(
  SourceControlHost.SourceControlHost,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const process = yield* VcsProcess.VcsProcess;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const accounts = yield* Effect.serviceOption(SourceControlAccounts);
    // The Bitbucket account selected in the Source Control hub predates the host settings form
    // and remains the explicit user choice, so it reads as that host's saved credential.
    const settings = Option.isNone(accounts)
      ? serverSettings.getSettings
      : Effect.all([
          serverSettings.getSettings,
          accounts.value.credential("bitbucket").pipe(Effect.orElseSucceed(() => undefined)),
        ]).pipe(
          Effect.map(([current, account]) =>
            account === undefined || account.token.length === 0
              ? current
              : {
                  ...current,
                  sourceControlHosts: {
                    ...current.sourceControlHosts,
                    bitbucket: account.username
                      ? { accessToken: "", email: account.username, apiToken: account.token }
                      : { accessToken: account.token, email: "", apiToken: "" },
                  },
                },
          ),
        );
    const secrets = yield* SecretResolver.SecretResolver;
    return SourceControlHost.SourceControlHost.of({
      settings: {
        get: settings,
        getWithSecrets: (kind) =>
          settings.pipe(
            Effect.flatMap((settings) =>
              resolveSourceControlHostSecrets(secrets, settings.sourceControlHosts, kind).pipe(
                Effect.map((sourceControlHosts) =>
                  sourceControlHosts === settings.sourceControlHosts
                    ? settings
                    : { ...settings, sourceControlHosts },
                ),
              ),
            ),
          ),
        update: serverSettings.updateSettings,
      },
      process: { run: process.run },
      git: {
        execute: git.execute,
        resolveCommit: git.resolveCommit,
        remotes: (cwd) =>
          vcsRegistry.resolve({ cwd }).pipe(Effect.map((handle) => handle.driver.listRemotes(cwd))),
        readConfigValue: git.readConfigValue,
        resolvePrimaryRemoteName: git.resolvePrimaryRemoteName,
        ensureRemote: git.ensureRemote,
        listLocalBranchNames: git.listLocalBranchNames,
        fetchRemoteBranch: git.fetchRemoteBranch,
        fetchRemoteTrackingBranch: git.fetchRemoteTrackingBranch,
        setBranchUpstream: git.setBranchUpstream,
        createBranch: git.createBranch,
        writeConfigValue: git.writeConfigValue,
        switchRef: git.switchRef,
      },
    });
  }),
).pipe(Layer.provide(SecretResolverLayer.layer));
