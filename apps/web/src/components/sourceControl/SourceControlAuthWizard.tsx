import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { CheckCircle2Icon, ChevronRightIcon, KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLink } from "../../browser/useOpenLink";
import { GitHubIcon, BitbucketIcon } from "../Icons";
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
import { HubSelect } from "./HubSelect";

export function SourceControlAuthWizard({
  environmentId: initialEnvironmentId,
  onConnected,
}: {
  environmentId?: EnvironmentId;
  onConnected?: () => void;
}) {
  const { environments } = useEnvironments();
  const [environmentId, setEnvironmentId] = useState(
    initialEnvironmentId ?? environments[0]?.environmentId ?? "",
  );
  const [provider, setProvider] = useState<"github" | "bitbucket">("github");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [authType, setAuthType] = useState<"api" | "access">("api");
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const connect = useAtomCommand(serverEnvironment.sourceControlHubConnectAccount, {
    reportFailure: false,
  });
  const verifyExisting = useAtomCommand(serverEnvironment.sourceControlHubRepositories, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.sourceControlHubRefresh);
  const openLink = useOpenLink(null);
  const environment =
    environments.find((env) => env.environmentId === environmentId) ?? environments[0];
  const close = (value: boolean) => {
    if (pending) return;
    setOpen(value);
    if (!value) {
      setToken("");
      setError(null);
    }
  };
  const done = (account: string) => {
    setIdentity(account);
    setToken("");
    setStep(2);
    onConnected?.();
  };
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setStep(0);
          setError(null);
          setOpen(true);
        }}
      >
        <KeyRoundIcon className="size-3.5" />
        Connect account
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogPopup className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect source control</DialogTitle>
            <DialogDescription>
              Connect the account used to browse repositories and publish your reviews.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <ol className="flex items-center gap-2 text-xs text-muted-foreground">
              {["Provider", "Authenticate", "Connected"].map((label, index) => (
                <li
                  key={label}
                  className={`flex items-center gap-2 ${step === index ? "font-medium text-foreground" : ""}`}
                >
                  <span
                    className={`grid size-5 place-items-center rounded-full ${step >= index ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  >
                    {index + 1}
                  </span>
                  {label}
                  {index < 2 && <ChevronRightIcon className="size-3" />}
                </li>
              ))}
            </ol>
            {step === 0 && (
              <>
                <label className="grid gap-2 text-sm">
                  Environment
                  <HubSelect
                    label="Account environment"
                    value={environment?.environmentId ?? ""}
                    options={environments.map((env) => ({
                      value: env.environmentId,
                      label: env.label,
                    }))}
                    onChange={setEnvironmentId}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  {(["github", "bitbucket"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={provider === value}
                      className={`flex flex-col items-start gap-3 rounded-lg border p-4 text-left ${provider === value ? "border-primary bg-accent ring-1 ring-primary" : "hover:bg-muted/40"}`}
                      onClick={() => {
                        setProvider(value);
                        setUsername("");
                        setToken("");
                      }}
                    >
                      {value === "github" ? (
                        <GitHubIcon className="size-6" />
                      ) : (
                        <BitbucketIcon className="size-6" />
                      )}
                      <span className="font-medium">
                        {value === "github" ? "GitHub" : "Bitbucket"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Repositories, pull requests and reviews
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Credentials are owned by {environment?.label ?? "the selected environment"}. Other
                  environments keep their own accounts.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-3">
                  <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1 text-xs">
                    <p className="font-medium">Verify before saving</p>
                    <p className="text-muted-foreground">
                      T3 checks the account with the provider. An invalid token will not replace
                      your existing credentials.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={pending || !environment}
                  onClick={async () => {
                    if (!environment) return;
                    setPending(true);
                    setError(null);
                    try {
                      await refresh({ environmentId: environment.environmentId, input: {} });
                      const result = await verifyExisting({
                        environmentId: environment.environmentId,
                        input: { provider },
                      });
                      if (result._tag === "Success") done("Existing environment credentials");
                      else
                        setError(
                          "Existing credentials could not access repositories. Connect with a token below.",
                        );
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  Use existing environment credentials
                </Button>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or connect with an API token
                  <span className="h-px flex-1 bg-border" />
                </div>
                {provider === "bitbucket" && (
                  <HubSelect
                    label="Authentication method"
                    showLabel
                    value={authType}
                    onChange={setAuthType}
                    options={[
                      { value: "api", label: "API token · Atlassian email" },
                      { value: "access", label: "Integration access token · Bearer" },
                    ]}
                  />
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5 text-sm">
                    Account label
                    <Input
                      value={name}
                      placeholder="Personal or work"
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  {provider === "bitbucket" && authType === "api" && (
                    <label className="grid gap-1.5 text-sm">
                      Atlassian email
                      <Input
                        type="email"
                        autoComplete="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                    </label>
                  )}
                  {provider === "bitbucket" && (
                    <label className="grid gap-1.5 text-sm sm:col-span-2">
                      Workspace {authType === "api" ? "(optional)" : "(required)"}
                      <Input
                        value={workspace}
                        onChange={(event) => setWorkspace(event.target.value)}
                      />
                    </label>
                  )}
                </div>
                {provider === "bitbucket" && (
                  <label className="grid gap-1.5 text-sm">
                    Repository slug (for repository-scoped tokens)
                    <Input
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                      placeholder="my-repository"
                    />
                  </label>
                )}
                <label className="grid gap-1.5 text-sm">
                  Token
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </label>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    {provider === "github"
                      ? "Give the token access to the repositories you need, with Pull requests and Contents permissions for the actions you plan to use. GitHub CLI must be installed in this environment."
                      : "API tokens use your Atlassian email. Repository or workspace access tokens use Bearer authentication and require a workspace. For a repository token, enter its repository slug. Repository read is sufficient to verify access; publishing requires additional permissions."}
                  </p>
                  <Button
                    size="xs"
                    variant="link"
                    onClick={() =>
                      void openLink(
                        provider === "github"
                          ? "https://github.com/settings/personal-access-tokens/new"
                          : "https://id.atlassian.com/manage-profile/security/api-tokens",
                      )
                    }
                  >
                    Create a token with {provider === "github" ? "GitHub" : "Atlassian"}
                  </Button>
                </div>
              </>
            )}
            {step === 2 && (
              <div className="space-y-4 py-4 text-center">
                <CheckCircle2Icon className="mx-auto size-10 text-emerald-600" />
                <div>
                  <h3 className="font-semibold">{identity}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Connected in {environment?.label}
                  </p>
                </div>
                <p className="text-left text-xs text-muted-foreground">
                  Account authenticated. Repository visibility and available actions depend on the
                  token permissions. Git fetch and push use this environment's SSH keys or Git
                  credential manager; connecting the API does not change your Git remotes.
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => (step === 1 ? setStep(0) : close(false))}
            >
              {step === 1 ? "Back" : step === 2 ? "Close" : "Cancel"}
            </Button>
            {step === 0 ? (
              <Button disabled={!environment} onClick={() => setStep(1)}>
                Continue
                <ChevronRightIcon className="size-4" />
              </Button>
            ) : step === 1 ? (
              <Button
                disabled={
                  pending ||
                  !environment ||
                  !token.trim() ||
                  (provider === "bitbucket" &&
                    (authType === "api" ? !username.trim() : !workspace.trim()))
                }
                onClick={async () => {
                  if (!environment) return;
                  setPending(true);
                  setError(null);
                  try {
                    const result = await connect({
                      environmentId: environment.environmentId,
                      input: {
                        account: {
                          provider,
                          label: name.trim() || (provider === "github" ? "GitHub" : "Bitbucket"),
                          username:
                            provider === "bitbucket" && authType === "access"
                              ? ""
                              : username.trim(),
                          workspace: workspace.trim(),
                          repository: repository.trim(),
                        },
                        token: token.trim(),
                      },
                    });
                    if (result._tag === "Success") done(result.value.accountName);
                    else {
                      const failure = squashAtomCommandFailure(result);
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "Could not verify this account. Check the token type and repository permissions.",
                      );
                    }
                  } finally {
                    setPending(false);
                  }
                }}
              >
                {pending ? "Verifying…" : "Verify and connect"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
