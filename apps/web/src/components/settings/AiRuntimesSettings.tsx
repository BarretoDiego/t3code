import {
  runtimeAvailability,
  runtimeForConsumer,
  runtimeBindingSelection,
} from "@t3tools/client-runtime/ai-runtimes";
import { randomUUID } from "../../lib/utils";
import { useId, useState } from "react";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { Switch } from "../ui/switch";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { SettingsPageContainer, SettingsSearchTarget, SettingsSection } from "./settingsLayout";

function RuntimeSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  size = "default",
}: {
  label: string;
  value: Value | "";
  options: ReadonlyArray<{ value: Value; label: string; disabled?: boolean }>;
  onChange: (value: Value) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "default" | "sm";
}) {
  return (
    <Select
      disabled={disabled || options.length === 0}
      value={value || null}
      items={options}
      onValueChange={(value) => {
        const option = options.find((option) => option.value === value);
        if (option && !option.disabled) onChange(option.value);
      }}
    >
      <SelectTrigger size={size} aria-label={label} className="min-w-0">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} popupClassName="max-w-[calc(100vw-2rem)]">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            <span className="block break-words">{option.label}</span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
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
  environmentName,
}: {
  error?: string | null;
  environmentName: string;
  initial: AiRuntimeConfig;
  onClose: () => void;
  onSave: (runtime: AiRuntimeConfig, key?: string) => Promise<boolean>;
}) {
  const formId = useId();
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState("");
  const [changeKey, setChangeKey] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup
        className="max-h-[min(calc(100dvh-4rem),56rem)] max-w-xl"
        showCloseButton={!pending}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Configure AI Runtime</DialogTitle>
          <DialogDescription className="break-words">
            {environmentName} tests and uses this endpoint. Network access must already be
            configured on the runtime.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setPending(true);
              try {
                if (await onSave(draft, changeKey ? key : undefined)) onClose();
              } finally {
                setPending(false);
              }
            }}
          >
            <fieldset disabled={pending} className="grid min-w-0 gap-4">
              <label className="grid min-w-0 gap-1.5 text-sm">
                Name
                <Input
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Runtime type
                <Input
                  required
                  value={draft.runtimeKind}
                  onChange={(e) => setDraft({ ...draft, runtimeKind: e.target.value })}
                  placeholder="ollama, vllm, lm-studio…"
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Compatibility
                <RuntimeSelect
                  disabled={pending || draft.id === "ollama-local"}
                  label="Compatibility"
                  value={draft.protocol}
                  onChange={(protocol) => setDraft({ ...draft, protocol })}
                  options={[
                    { value: "ollama", label: "Ollama native" },
                    { value: "openai", label: "OpenAI compatible" },
                    { value: "anthropic", label: "Anthropic compatible" },
                    { value: "transcription", label: "Whisper / OpenAI transcription" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Base URL
                <Input
                  required
                  type="url"
                  readOnly={draft.id === "ollama-local"}
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="http://127.0.0.1:11434 or https://host/v1"
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
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
                  Explicit address for other environments. Listening stays local unless enabled
                  below.
                </span>
              </label>
              {draft.id === "ollama-local" && (
                <label className="flex items-start gap-2 text-sm">
                  <Switch
                    aria-label="Allow managed Tailnet listening"
                    checked={draft.listenOnTailnet ?? false}
                    onCheckedChange={(checked) => setDraft({ ...draft, listenOnTailnet: checked })}
                  />
                  <span>
                    Allow managed Ollama to listen on this node's Tailscale IPv4 address on next
                    start. Use port 11434 above. Tailnet ACLs control access; Ollama has no API
                    authentication.
                  </span>
                </label>
              )}
              <label className="grid min-w-0 gap-1.5 text-sm">
                Authentication
                <RuntimeSelect
                  disabled={pending}
                  label="Authentication"
                  value={draft.authentication}
                  onChange={(authentication) => setDraft({ ...draft, authentication })}
                  options={[
                    { value: "none", label: "None" },
                    { value: "bearer", label: "Bearer token" },
                    { value: "api-key", label: "API key header" },
                  ]}
                />
              </label>
              {draft.authentication !== "none" && (
                <label className="grid min-w-0 gap-1.5 text-sm">
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
                <label className="grid min-w-0 gap-1.5 text-sm">
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
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        </DialogPanel>
        <DialogFooter className="shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending}>
            {pending ? "Saving…" : "Save and test endpoint"}
          </Button>
        </DialogFooter>
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
  onAction: (input: AiRuntimeActionInput) => Promise<boolean>;
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
  const {
    drivers,
    driver: effectiveDriver,
    model: effectiveModel,
  } = runtimeBindingSelection(runtime, { driver, model });
  const [instanceId, setInstanceId] = useState("");
  const [binding, setBinding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    run: () => void;
  } | null>(null);
  const busy = !online || submitting || binding || runtime.operation?.phase === "running";
  const act = async (action: AiRuntimeActionInput["action"], selectedModel?: string) => {
    if (busy) return;
    setSubmitting(true);
    try {
      await onAction({
        runtimeId: runtime.id,
        action,
        ...(selectedModel ? { model: selectedModel } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  };
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
    <article className="min-w-0 space-y-4 rounded-xl border border-border/60 bg-card/40 p-3 shadow-xs/5 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="break-words text-sm font-medium">{runtime.name}</h3>
          <p className="text-xs text-muted-foreground font-mono break-all mt-1">
            {runtime.baseUrl}
          </p>
        </div>
        <Badge variant="outline" className="max-w-full whitespace-normal">
          {status}
        </Badge>
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
        <Button size="xs" variant="outline" disabled={busy} onClick={onEdit}>
          Configure
        </Button>
        {runtime.id === "ollama-local" && (
          <>
            {runtime.installation === "absent" && (
              <Button size="xs" disabled={busy} onClick={() => act("install")}>
                Install Ollama
              </Button>
            )}
            {runtime.installation !== "absent" && runtime.status !== "available" && (
              <Button size="xs" disabled={busy} onClick={() => act("start")}>
                Start
              </Button>
            )}
            {runtime.ownedProcess && (
              <Button size="xs" variant="outline" disabled={busy} onClick={() => act("stop")}>
                Stop
              </Button>
            )}
            {runtime.installation === "managed" && (
              <>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => act("update")}>
                  Update
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || runtime.ownedProcess}
                  onClick={() =>
                    setConfirmation({
                      title: "Remove managed installation?",
                      description:
                        "Only the T3-managed Ollama installation will be removed. Downloaded models are kept.",
                      run: () => {
                        void act("remove-installation");
                      },
                    })
                  }
                >
                  Remove managed installation
                </Button>
              </>
            )}
          </>
        )}
        {runtime.networkBaseUrl && (
          <Button size="xs" variant="outline" disabled={busy} onClick={onUseRemote}>
            Use on another node
          </Button>
        )}
        {runtime.source === "configured" && (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setConfirmation({
                title: "Forget endpoint?",
                description:
                  "This removes its saved configuration and credential from this environment. The runtime itself is kept.",
                run: onRemove,
              })
            }
          >
            Forget endpoint
          </Button>
        )}
      </div>
      {runtime.operation && (
        <div className="rounded-md bg-muted p-3 text-xs space-y-2" role="status">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="min-w-0 break-words">{runtime.operation.message}</span>
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
              size="xs"
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
          {runtime.models.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {runtime.status === "available"
                ? "No models discovered. Refresh the catalog or pull an Ollama model."
                : "Connect to the runtime to discover its models."}
            </p>
          )}
          {runtime.models.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 border-b border-border/50 pb-2"
            >
              <div className="min-w-0 flex-1">
                <p className="break-all text-sm font-mono">{item.id}</p>
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
                  size="xs"
                  variant="ghost"
                  disabled={busy || runtime.status !== "available"}
                  onClick={() =>
                    setConfirmation({
                      title: `Remove ${item.id}?`,
                      description:
                        "This model will be deleted from the runtime. You can pull it again later.",
                      run: () => {
                        void act("remove-model", item.id);
                      },
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {runtime.protocol === "ollama" && (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={(e) => {
                e.preventDefault();
                act("pull", pull);
              }}
            >
              <Input
                size="sm"
                className="min-w-0 flex-1"
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
            if (busy || !effectiveDriver || !effectiveModel) return;
            setBinding(true);
            try {
              if (
                effectiveDriver &&
                effectiveModel &&
                (await onBind(effectiveDriver, effectiveModel, instanceId))
              ) {
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
          <label className="grid min-w-0 gap-1.5 text-sm">
            Agent
            <RuntimeSelect
              size="sm"
              label="Agent"
              value={effectiveDriver ?? ""}
              onChange={setDriver}
              placeholder="No compatible agent"
              options={drivers.map((value) => ({
                value,
                label:
                  value === "opencode"
                    ? "OpenCode"
                    : value === "codex"
                      ? "Codex (Responses API required)"
                      : "Claude Code (Anthropic API required)",
              }))}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            Model
            <RuntimeSelect
              size="sm"
              label="Model"
              value={effectiveModel}
              onChange={setModel}
              placeholder="Select model"
              options={runtime.models.map((item) => ({ value: item.id, label: item.id }))}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm">
            New provider instance ID
            <Input
              size="sm"
              required
              pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}"
              placeholder="opencode_gpu"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            className="sm:justify-self-start"
            disabled={
              busy ||
              binding ||
              runtime.status !== "available" ||
              !effectiveModel ||
              !effectiveDriver ||
              !instanceId ||
              !["ollama", "openai", "anthropic"].includes(runtime.protocol)
            }
          >
            {binding ? "Configuring…" : "Create agent binding"}
          </Button>
        </form>
      </details>
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                confirmation?.run();
                setConfirmation(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
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
  const [refreshing, setRefreshing] = useState(false);
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
    <SettingsSection
      title={environment.label}
      description={online ? "Online" : "Offline"}
      icon={<ServerIcon className="size-4 shrink-0 text-muted-foreground" />}
      variant="plain"
      headerAction={
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={!online || !supported || refreshing}
            onClick={async () => {
              if (refreshing) return;
              setRefreshing(true);
              try {
                result(await refresh({ ...target, input: { refresh: true } }));
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!online || !supported}
            onClick={() => {
              setError(null);
              setEditor(blankRuntime());
            }}
          >
            <PlusIcon className="size-3.5" />
            Add runtime
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {!supported && (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            {online
              ? "Update this environment to enable AI Runtimes."
              : "Connect to this node to discover its runtimes."}
          </p>
        )}
        {(error ?? query.error) && (
          <p role="alert" className="break-words px-3 text-sm text-destructive sm:px-4">
            {error ?? query.error}
          </p>
        )}
        {notice && (
          <p role="status" className="px-3 text-sm sm:px-4">
            {notice}
          </p>
        )}
        {supported && !query.data && !query.error && (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            {online ? "Discovering local runtimes…" : "Connect to this node to load its runtimes."}
          </p>
        )}
        {query.data?.runtimes.map((runtime) => (
          <RuntimeCard
            key={runtime.id}
            runtime={runtime}
            online={online}
            onAction={async (input) => result(await action({ ...target, input }))}
            onEdit={() => {
              setError(null);
              setEditor(runtime);
            }}
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
            environmentName={environment.label}
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
      </div>
    </SettingsSection>
  );
}

export function AiRuntimesSettingsPanel() {
  const { environments } = useEnvironments();
  const [remote, setRemote] = useState<AiRuntime | null>(null);
  const [targetId, setTargetId] = useState("");
  const [importId, setImportId] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const save = useAtomCommand(serverEnvironment.aiRuntimesSave);
  const target = environments.find((item) => item.environmentId === targetId);
  return (
    <SettingsPageContainer>
      <div className="space-y-8">
        <SettingsSearchTarget id="ai-runtimes" className="px-3 sm:px-4">
          <h1 className="text-sm font-medium">AI Runtimes</h1>
          <p className="mt-1 text-[13px] leading-[1.45] text-muted-foreground/80">
            Discover model endpoints on your environments and connect them to agent providers.
          </p>
        </SettingsSearchTarget>
        {environments.map((environment) => (
          <EnvironmentRuntimes
            key={environment.environmentId}
            environment={environment}
            onRemote={(runtime) => {
              setTargetId("");
              setImportId(`remote-${randomUUID()}`);
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
              <DialogHeader className="shrink-0 pr-12">
                <DialogTitle className="break-words">Use {remote.name} on another node</DialogTitle>
                <DialogDescription className="break-words">
                  The consuming environment will test the explicit network address. Its API key
                  stays in that environment's secret store.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-3">
                <RuntimeSelect
                  label="Consuming node"
                  value={targetId}
                  onChange={setTargetId}
                  placeholder="Select consuming node"
                  options={environments
                    .filter(
                      (item) =>
                        item.environmentId !== remote.environmentId &&
                        item.connection.phase === "connected" &&
                        item.serverConfig?.environment.capabilities.aiRuntimes,
                    )
                    .map((item) => ({ value: item.environmentId, label: item.label }))}
                />
                {!environments.some(
                  (item) =>
                    item.environmentId !== remote.environmentId &&
                    item.connection.phase === "connected" &&
                    item.serverConfig?.environment.capabilities.aiRuntimes,
                ) && (
                  <p className="text-sm text-muted-foreground">
                    Connect another environment with AI Runtimes enabled in Settings → Connections.
                  </p>
                )}
              </DialogPanel>
              <DialogFooter className="shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <Button variant="ghost" onClick={() => setRemote(null)}>
                  Cancel
                </Button>
              </DialogFooter>
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
              initial={runtimeForConsumer(remote, importId)}
              environmentName={target.label}
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
