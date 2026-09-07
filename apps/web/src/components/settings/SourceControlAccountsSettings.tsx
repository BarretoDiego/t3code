import { SourceControlAuthWizard } from "../sourceControl/SourceControlAuthWizard";
import { useState } from "react";
import type { SourceControlAccountConfig } from "@t3tools/contracts";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsSection } from "./settingsLayout";

function EnvironmentAccounts({ environment }: { environment: EnvironmentPresentation }) {
  const query = useEnvironmentQuery(
    serverEnvironment.sourceControlHubAccounts({
      environmentId: environment.environmentId,
      input: {},
    }),
  );
  const save = useAtomCommand(serverEnvironment.sourceControlHubSaveAccount);
  const remove = useAtomCommand(serverEnvironment.sourceControlHubRemoveAccount);
  const refresh = useAtomCommand(serverEnvironment.sourceControlHubRefresh);
  const [draft, setDraft] = useState<SourceControlAccountConfig | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = { environmentId: environment.environmentId };
  const close = () => {
    setDraft(null);
    setToken("");
    setError(null);
  };
  return (
    <SettingsSection
      title={`${environment.label} accounts`}
      variant="plain"
      headerAction={
        <SourceControlAuthWizard
          environmentId={environment.environmentId}
          onConnected={query.refresh}
        />
      }
    >
      <div className="divide-y rounded-lg border">
        {(["github", "bitbucket"] as const).map((provider) => {
          const account = query.data?.find((account) => account.provider === provider);
          return (
            <div key={provider} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium">{provider === "github" ? "GitHub" : "Bitbucket"}</p>
                <p className="break-words text-sm text-muted-foreground">
                  {account
                    ? `${account.label} · ${account.credentialSource === "environment" ? "Detected in environment" : account.hasCredential ? "Credential saved" : "No saved token"}`
                    : "Environment credentials"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setToken("");
                    setDraft(
                      account ?? {
                        provider,
                        label: provider === "github" ? "GitHub" : "Bitbucket",
                        username: "",
                        workspace: "",
                      },
                    );
                  }}
                >
                  Manage
                </Button>
                {account && account.credentialSource !== "environment" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={async () => {
                      setPending(true);
                      try {
                        const result = await remove({ ...target, input: { provider } });
                        if (result._tag === "Success") {
                          await refresh({ ...target, input: {} });
                          query.refresh();
                        } else setError("Could not remove this account.");
                      } finally {
                        setPending(false);
                      }
                    }}
                  >
                    Use environment credentials
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {draft && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !pending) close();
          }}
        >
          <DialogPopup className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {draft.provider === "github" ? "GitHub" : "Bitbucket"} account
              </DialogTitle>
              <DialogDescription>
                The credential stays on {environment.label}. Leave it blank to retain the saved
                credential.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (pending) return;
                setPending(true);
                try {
                  const result = await save({
                    ...target,
                    input: { account: draft, ...(token ? { token } : {}) },
                  });
                  if (result._tag === "Success") {
                    await refresh({ ...target, input: {} });
                    query.refresh();
                    close();
                  } else setError("Could not save this account.");
                } finally {
                  setPending(false);
                }
              }}
            >
              <DialogPanel className="space-y-4">
                <label className="grid gap-2 text-sm">
                  Name
                  <Input
                    required
                    value={draft.label}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  />
                </label>
                {draft.provider === "bitbucket" && (
                  <>
                    <label className="grid gap-2 text-sm">
                      Email for API token (empty for bearer token)
                      <Input
                        type="email"
                        value={draft.username}
                        onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-2 text-sm">
                      Workspace
                      <Input
                        value={draft.workspace}
                        onChange={(event) => setDraft({ ...draft, workspace: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-2 text-sm">
                      Repository slug (repository-scoped tokens)
                      <Input
                        value={draft.repository ?? ""}
                        onChange={(event) => setDraft({ ...draft, repository: event.target.value })}
                      />
                    </label>
                  </>
                )}
                <label className="grid gap-2 text-sm">
                  API token
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
              </DialogPanel>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={pending} onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending || !draft.label.trim()}>
                  {pending ? "Saving…" : "Save account"}
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      )}
    </SettingsSection>
  );
}
export function SourceControlAccountsSettings() {
  return (
    <>
      {useEnvironments().environments.map((environment) => (
        <EnvironmentAccounts key={environment.environmentId} environment={environment} />
      ))}
    </>
  );
}
