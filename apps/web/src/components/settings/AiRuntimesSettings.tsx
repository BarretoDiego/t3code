import { runtimeAvailability, runtimeForConsumer } from "@t3tools/client-runtime/ai-runtimes";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import {
  type AiRuntime,
  type AiRuntimeConfig,
  type AiRuntimeActionInput,
  type AiRuntimeBindInput,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { SettingsPageContainer } from "./settingsLayout";

const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
const blankRuntime = (): AiRuntimeConfig => ({
  id: `runtime-${randomUUID()}`,
  name: "",
  runtimeKind: "openai-compatible",
  protocol: "openai",
  baseUrl: "",
  authentication: "none",
  configuredModels: [],
});

function RuntimeEditor({
  initial,
  onClose,
  onSave,
  error,
}: {
  error?: string | null;
  initial: AiRuntimeConfig;
  onClose: () => void;
  onSave: (runtime: AiRuntimeConfig, key?: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState("");
  const [changeKey, setChangeKey] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Configure AI Runtime</DialogTitle>
          <DialogDescription>
            The selected environment tests this endpoint. Network access must already be configured
            on the runtime.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            try {
              if (await onSave(draft, changeKey ? key : undefined)) onClose();
            } finally {
              setPending(false);
            }
          }}
        >
          <label className="grid gap-1 text-sm">
            Name
            <Input
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-sm">
            Runtime type
            <Input
              required
              value={draft.runtimeKind}
              onChange={(e) => setDraft({ ...draft, runtimeKind: e.target.value })}
              placeholder="ollama, vllm, lm-studio…"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Compatibility
            <select
              className={selectClass}
              value={draft.protocol}
              onChange={(e) =>
                setDraft({ ...draft, protocol: e.target.value as AiRuntimeConfig["protocol"] })
              }
            >
              <option value="ollama">Ollama native</option>
              <option value="openai">OpenAI compatible</option>
              <option value="anthropic">Anthropic compatible</option>
              <option value="transcription">Whisper / OpenAI transcription</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Base URL
            <Input
              required
              type="url"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder="http://127.0.0.1:11434 or https://host/v1"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Network base URL (optional)
            <Input
              type="url"
              value={draft.networkBaseUrl ?? ""}
              onChange={(e) => {
                const { networkBaseUrl: _, ...rest } = draft;
                setDraft(e.target.value ? { ...rest, networkBaseUrl: e.target.value } : rest);
              }}
              placeholder="http://gpu-server.tailnet:11434"
            />
            <span className="text-xs text-muted-foreground">
              Explicit address for other environments. Listening stays local unless enabled below.
            </span>
          </label>
          {draft.id === "ollama-local" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.listenOnTailnet ?? false}
                onChange={(event) => setDraft({ ...draft, listenOnTailnet: event.target.checked })}
              />
              <span>
                Allow managed Ollama to listen on this node's Tailscale IPv4 address on next start.
                Use port 11434 above. Tailnet ACLs control access; Ollama has no API authentication.
              </span>
            </label>
          )}
          <label className="grid gap-1 text-sm">
            Authentication
            <select
              className={selectClass}
              value={draft.authentication}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  authentication: e.target.value as AiRuntimeConfig["authentication"],
                })
              }
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="api-key">API key header</option>
            </select>
          </label>
          {draft.authentication !== "none" && (
            <label className="grid gap-1 text-sm">
              API key
              <Input
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={(e) => {
                  setChangeKey(true);
                  setKey(e.target.value);
                }}
                placeholder="Leave untouched to preserve saved key"
              />
            </label>
          )}
          {(draft.protocol === "custom" || draft.protocol === "transcription") && (
            <label className="grid gap-1 text-sm">
              Model IDs (comma separated)
              <Input
                value={draft.configuredModels.join(", ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    configuredModels: e.target.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  })
                }
              />
              <span className="text-xs text-muted-foreground">
                No standard discovery API; availability remains unverified.
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save and test endpoint"}
          </Button>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function RuntimeCard({
  runtime,
  online,
  onAction,
  onEdit,
  onRemove,
  onBind,
  onUseRemote,
}: {
  runtime: AiRuntime;
  online: boolean;
  onAction: (input: AiRuntimeActionInput) => void;
  onEdit: () => void;
  onRemove: () => void;
  onBind: (
    driver: AiRuntimeBindInput["driver"],
    model: string,
    instanceId: string,
  ) => Promise<boolean>;
  onUseRemote: () => void;
}) {
  const [pull, setPull] = useState("");
  const [model, setModel] = useState(runtime.models[0]?.id ?? "");
  const [driver, setDriver] = useState<AiRuntimeBindInput["driver"]>(
    runtime.protocol === "anthropic" ? "claudeAgent" : "opencode",
  );
  const [instanceId, setInstanceId] = useState("");
  const [binding, setBinding] = useState(false);
  const busy = !online || runtime.operation?.phase === "running";
  const act = (action: AiRuntimeActionInput["action"], selectedModel?: string) =>
    onAction({ runtimeId: runtime.id, action, ...(selectedModel ? { model: selectedModel } : {}) });
  const access = runtimeAvailability(runtime, online);
  const status = !online
    ? "Unavailable · node offline"
    : runtime.status === "available"
      ? "Running"
      : runtime.status === "authentication-required"
        ? "Authentication required"
        : runtime.installation === "absent"
          ? "Not detected"
          : "Unavailable";
  return (
    <article className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{runtime.name}</h3>
          <p className="text-xs text-muted-foreground font-mono break-all mt-1">
            {runtime.baseUrl}
          </p>
        </div>
        <Badge variant="outline">{status}</Badge>
      </div>
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>
          {runtime.installation === "managed"
            ? "T3-managed"
            : runtime.installation === "external"
              ? "Existing installation / endpoint"
              : "No installation detected"}
        </span>
        {runtime.version && <span>· {runtime.version}</span>}
        <span>· {access.label}</span>
        {runtime.networkBaseUrl && access.label === "Local only" && (
          <span>· Network address configured · verify on consuming node</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
          Configure
        </Button>
        {runtime.id === "ollama-local" && (
          <>
            {runtime.installation === "absent" && (
              <Button size="sm" disabled={busy} onClick={() => act("install")}>
                Install Ollama
              </Button>
            )}
            {runtime.installation !== "absent" && runtime.status !== "available" && (
              <Button size="sm" disabled={busy} onClick={() => act("start")}>
                Start
              </Button>
            )}
            {runtime.ownedProcess && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act("stop")}>
                Stop
              </Button>
            )}
            {runtime.installation === "managed" && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act("update")}>
                  Update
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || runtime.ownedProcess}
                  onClick={() => act("remove-installation")}
                >
                  Remove managed installation
                </Button>
              </>
            )}
          </>
        )}
        {runtime.networkBaseUrl && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onUseRemote}>
            Use on another node
          </Button>
        )}
        {runtime.source === "configured" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            Forget endpoint
          </Button>
        )}
      </div>
      {runtime.operation && (
        <div className="rounded-md bg-muted p-3 text-xs space-y-2" role="status">
          <div className="flex justify-between gap-2">
            <span>{runtime.operation.message}</span>
            <span>{runtime.operation.phase}</span>
          </div>
          {runtime.operation.total !== null && runtime.operation.total > 0 && (
            <progress
              className="w-full h-1.5"
              max={runtime.operation.total}
              value={runtime.operation.completed}
              aria-label="Runtime operation progress"
            />
          )}
          {runtime.operation.phase === "running" && (
            <Button
              size="sm"
              variant="outline"
              disabled={!online}
              onClick={() =>
                onAction({
                  runtimeId: runtime.id,
                  action: "cancel",
                  operationId: runtime.operation!.id,
                })
              }
            >
              Cancel
            </Button>
          )}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Models · {runtime.models.length}
        </summary>
        <div className="mt-3 space-y-2">
          {runtime.models.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 border-b pb-2">
              <div>
                <p className="text-sm font-mono">{item.id}</p>
                <p className="text-xs text-muted-foreground">
                  {!online || runtime.status !== "available" ? "Unavailable (cached)" : "Available"}{" "}
                  ·{" "}
                  {item.capabilitiesKnown
                    ? item.capabilities.join(", ") || "No known capabilities"
                    : "Capabilities unknown"}
                </p>
              </div>
              {runtime.protocol === "ollama" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || runtime.status !== "available"}
                  onClick={() => act("remove-model", item.id)}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {runtime.protocol === "ollama" && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                act("pull", pull);
              }}
            >
              <Input
                aria-label="Model to pull"
                placeholder="Model name, e.g. qwen3-coder"
                value={pull}
                onChange={(e) => setPull(e.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                disabled={busy || !pull.trim() || runtime.status !== "available"}
              >
                Pull model
              </Button>
            </form>
          )}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-sm font-medium">Use with an agent</summary>
        <form
          className="mt-3 grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBinding(true);
            try {
              if (await onBind(driver, model, instanceId)) {
                setInstanceId("");
              }
            } finally {
              setBinding(false);
            }
          }}
        >
          <p className="text-xs text-muted-foreground">
            Creates a provider instance for the existing chat provider/model selector. Configure
            each consuming node's credentials separately.
          </p>
          <label className="grid gap-1 text-sm">
            Agent
            <select
              className={selectClass}
              value={driver}
              onChange={(e) => setDriver(e.target.value as AiRuntimeBindInput["driver"])}
            >
              <option value="opencode" disabled={runtime.protocol === "anthropic"}>
                OpenCode
              </option>
              <option value="codex" disabled={runtime.protocol === "anthropic"}>
                Codex (Responses API required)
              </option>
              <option value="claudeAgent" disabled={runtime.protocol === "openai"}>
                Claude Code (Anthropic API required)
              </option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Model
            <select
              className={selectClass}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Select model</option>
              {runtime.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            New provider instance ID
            <Input
              required
              pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}"
              placeholder="opencode_gpu"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            disabled={
              busy ||
              binding ||
              runtime.status !== "available" ||
              !model ||
              !instanceId ||
              !["ollama", "openai", "anthropic"].includes(runtime.protocol)
            }
          >
            {binding ? "Configuring…" : "Create agent binding"}
          </Button>
        </form>
      </details>
    </article>
  );
}

function EnvironmentRuntimes({
  environment,
  onRemote,
}: {
  environment: EnvironmentPresentation;
  onRemote: (runtime: AiRuntime) => void;
}) {
  const online = environment.connection.phase === "connected";
  const supported = environment.serverConfig?.environment.capabilities.aiRuntimes === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.aiRuntimes({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const [editor, setEditor] = useState<AiRuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useAtomCommand(serverEnvironment.aiRuntimesList);
  const save = useAtomCommand(serverEnvironment.aiRuntimesSave);
  const remove = useAtomCommand(serverEnvironment.aiRuntimesRemove);
  const action = useAtomCommand(serverEnvironment.aiRuntimesAction);
  const bind = useAtomCommand(serverEnvironment.aiRuntimesBind);
  const result = (outcome: Awaited<ReturnType<typeof save>>) => {
    if (outcome._tag === "Failure") {
      const issue = squashAtomCommandFailure(outcome);
      setError(issue instanceof Error ? issue.message : "Runtime request failed");
      return false;
    }
    setError(null);
    return true;
  };
  const target = { environmentId: environment.environmentId };
  return (
    <section className="space-y-3">
      <div className="flex justify-between items-center gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <ServerIcon className="size-4 text-muted-foreground" />
          <h2 className="font-medium">{environment.label}</h2>
          <span className="text-xs text-muted-foreground">{online ? "Online" : "Offline"}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!online || !supported}
            onClick={async () => {
              result(await refresh({ ...target, input: { refresh: true } }));
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!online || !supported}
            onClick={() => setEditor(blankRuntime())}
          >
            <PlusIcon className="size-3.5" />
            Add runtime
          </Button>
        </div>
      </div>
      {!supported && (
        <p className="text-sm text-muted-foreground">
          {online
            ? "Update this environment to enable AI Runtimes."
            : "Connect to this node to discover its runtimes."}
        </p>
      )}
      {(error ?? query.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {supported && !query.data && (
        <p className="text-sm text-muted-foreground">Discovering local runtimes…</p>
      )}
      {query.data?.runtimes.map((runtime) => (
        <RuntimeCard
          key={runtime.id}
          runtime={runtime}
          online={online}
          onAction={async (input) => {
            result(await action({ ...target, input }));
          }}
          onEdit={() => setEditor(runtime)}
          onRemove={async () => {
            result(await remove({ ...target, input: { runtimeId: runtime.id } }));
          }}
          onUseRemote={() => onRemote(runtime)}
          onBind={async (driver, model, instanceId) => {
            const ok = result(
              await bind({
                ...target,
                input: {
                  runtimeId: runtime.id,
                  driver,
                  model,
                  instanceId: ProviderInstanceId.make(instanceId),
                },
              }),
            );
            if (ok)
              setNotice(
                "Agent binding created. Choose it in the chat provider selector; manage or remove it in Settings → Providers.",
              );
            return ok;
          }}
        />
      ))}
      {editor && (
        <RuntimeEditor
          initial={editor}
          error={error}
          onClose={() => setEditor(null)}
          onSave={async (runtime, apiKey) =>
            result(
              await save({
                ...target,
                input: { runtime, ...(apiKey !== undefined ? { apiKey } : {}) },
              }),
            )
          }
        />
      )}
    </section>
  );
}

export function AiRuntimesSettingsPanel() {
  const { environments } = useEnvironments();
  const [remote, setRemote] = useState<AiRuntime | null>(null);
  const [targetId, setTargetId] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const save = useAtomCommand(serverEnvironment.aiRuntimesSave);
  const target = environments.find((item) => item.environmentId === targetId);
  return (
    <SettingsPageContainer>
      <div className="space-y-8">
        <header>
          <h1 className="text-lg font-semibold">AI Runtimes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Discover model endpoints on your environments and connect them to agent providers.
          </p>
        </header>
        {environments.map((environment) => (
          <EnvironmentRuntimes
            key={environment.environmentId}
            environment={environment}
            onRemote={(runtime) => {
              setTargetId("");
              setRemoteError(null);
              setRemote(runtime);
            }}
          />
        ))}
        {environments.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Add an environment in Settings → Connections to begin.
          </p>
        )}
        {remote && !target && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setRemote(null);
            }}
          >
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Use {remote.name} on another node</DialogTitle>
                <DialogDescription>
                  The consuming environment will test the explicit network address. Its API key
                  stays in that environment's secret store.
                </DialogDescription>
              </DialogHeader>
              <select
                aria-label="Consuming node"
                className={`${selectClass} w-full`}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">Select consuming node</option>
                {environments
                  .filter(
                    (item) =>
                      item.environmentId !== remote.environmentId &&
                      item.connection.phase === "connected" &&
                      item.serverConfig?.environment.capabilities.aiRuntimes,
                  )
                  .map((item) => (
                    <option key={item.environmentId} value={item.environmentId}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </DialogPopup>
          </Dialog>
        )}
        {remote && target && (
          <>
            <p className="text-sm">Configuring endpoint on {target.label}</p>
            {remoteError && (
              <p role="alert" className="text-destructive">
                {remoteError}
              </p>
            )}
            <RuntimeEditor
              error={remoteError}
              initial={runtimeForConsumer(remote, `remote-${randomUUID()}`)}
              onClose={() => setRemote(null)}
              onSave={async (runtime, apiKey) => {
                const outcome = await save({
                  environmentId: target.environmentId,
                  input: { runtime, ...(apiKey !== undefined ? { apiKey } : {}) },
                });
                if (outcome._tag === "Failure") {
                  const issue = squashAtomCommandFailure(outcome);
                  setRemoteError(
                    issue instanceof Error ? issue.message : "Could not configure endpoint",
                  );
                  return false;
                }
                return true;
              }}
            />
          </>
        )}
      </div>
    </SettingsPageContainer>
  );
}
