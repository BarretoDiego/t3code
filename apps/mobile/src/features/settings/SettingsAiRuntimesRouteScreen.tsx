import {
  runtimeAvailability,
  runtimeForConsumer,
  runtimeBindingSelection,
} from "@t3tools/client-runtime/ai-runtimes";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AiRuntimeConfig,
  ProviderInstanceId,
  type AiRuntime,
  type AiRuntimeActionInput,
  type AiRuntimeBindInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const isRuntimeConfig = Schema.is(AiRuntimeConfig);
const isProviderId = Schema.is(ProviderInstanceId);
function Button({
  label,
  disabled,
  onPress,
  primary = false,
}: {
  label: string;
  disabled?: boolean;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 max-w-full justify-center rounded-xl px-4 py-2.5 disabled:opacity-40 ${primary ? "bg-primary" : "bg-muted"}`}
    >
      <Text
        className={`text-sm text-center font-t3-medium ${primary ? "text-primary-foreground" : "text-foreground"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Field({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        className="h-12 rounded-xl bg-field px-3 text-foreground"
      />
    </View>
  );
}
function check(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return true;
  const error = squashAtomCommandFailure(result);
  Alert.alert("AI Runtime", error instanceof Error ? error.message : "The operation failed.");
  return false;
}

function RuntimeEditor({
  environmentId,
  initial,
  onClose,
}: {
  environmentId: EnvironmentId;
  initial: AiRuntimeConfig;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useAtomCommand(serverEnvironment.aiRuntimesSave);
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-background"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={{ paddingTop: insets.top + 16 }} className="px-5 pb-4 border-b border-border">
          <Text className="text-xl font-t3-bold text-foreground">Configure AI Runtime</Text>
        </View>
        <ScrollView
          className="flex-1 bg-background"
          contentContainerStyle={{
            padding: 20,
            paddingBottom: 20,
            gap: 16,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Field
            label="Name"
            value={draft.name}
            onChange={(name) => setDraft({ ...draft, name })}
          />
          <Field
            label="Runtime type"
            value={draft.runtimeKind}
            onChange={(runtimeKind) => setDraft({ ...draft, runtimeKind })}
          />
          <Text className="text-sm text-foreground-muted">Compatibility</Text>
          <View className="flex-row flex-wrap gap-2">
            {(["ollama", "openai", "anthropic", "transcription", "custom"] as const).map(
              (protocol) => (
                <Button
                  key={protocol}
                  label={`${draft.protocol === protocol ? "✓ " : ""}${protocol}`}
                  onPress={() => setDraft({ ...draft, protocol })}
                />
              ),
            )}
          </View>
          <Field
            label="Base URL"
            value={draft.baseUrl}
            onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
          />
          <Field
            label="Network base URL (optional)"
            value={draft.networkBaseUrl ?? ""}
            onChange={(value) => {
              const { networkBaseUrl: _, ...rest } = draft;
              setDraft(value ? { ...rest, networkBaseUrl: value } : rest);
            }}
          />
          <Text className="text-xs text-foreground-muted">
            Use an explicitly configured Tailnet or private address. Listening stays local unless
            explicitly enabled.
          </Text>
          {draft.id === "ollama-local" && (
            <>
              <Button
                label={
                  draft.listenOnTailnet
                    ? "✓ Allow managed Tailnet listening"
                    : "Allow managed Tailnet listening"
                }
                onPress={() => setDraft({ ...draft, listenOnTailnet: !draft.listenOnTailnet })}
              />
              <Text className="text-xs text-foreground-muted">
                Explicitly binds this node's Tailscale IPv4 address on port 11434 on next start.
                Tailnet ACLs control access; Ollama has no API authentication.
              </Text>
            </>
          )}
          <View className="flex-row flex-wrap gap-2">
            {(["none", "bearer", "api-key"] as const).map((authentication) => (
              <Button
                key={authentication}
                label={`${draft.authentication === authentication ? "✓ " : ""}${authentication}`}
                onPress={() => setDraft({ ...draft, authentication })}
              />
            ))}
          </View>
          {draft.authentication !== "none" && (
            <Field
              label="API key (untouched preserves saved key)"
              value={key}
              secret
              onChange={(value) => {
                setKeyTouched(true);
                setKey(value);
              }}
            />
          )}
          {(draft.protocol === "custom" || draft.protocol === "transcription") && (
            <Field
              label="Model IDs (comma separated; availability unverified)"
              value={draft.configuredModels.join(", ")}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  configuredModels: value
                    .split(",")
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            />
          )}
        </ScrollView>
        <View
          className="gap-2 border-t border-border px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <Button
            primary
            label={busy ? "Saving…" : "Save and test endpoint"}
            disabled={busy || !isRuntimeConfig(draft)}
            onPress={async () => {
              setBusy(true);
              try {
                if (
                  check(
                    await save({
                      environmentId,
                      input: { runtime: draft, ...(keyTouched ? { apiKey: key } : {}) },
                    }),
                  )
                )
                  onClose();
              } finally {
                setBusy(false);
              }
            }}
          />
          <Button label="Cancel" disabled={busy} onPress={onClose} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function RuntimeRow({
  runtime,
  online,
  onEdit,
  onRemote,
}: {
  runtime: AiRuntime;
  online: boolean;
  onEdit: () => void;
  onRemote: () => void;
}) {
  const action = useAtomCommand(serverEnvironment.aiRuntimesAction);
  const remove = useAtomCommand(serverEnvironment.aiRuntimesRemove);
  const bind = useAtomCommand(serverEnvironment.aiRuntimesBind);
  const [pull, setPull] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [driver, setDriver] = useState<AiRuntimeBindInput["driver"]>(
    runtime.protocol === "anthropic" ? "claudeAgent" : "opencode",
  );
  const [model, setModel] = useState("");
  const {
    drivers,
    driver: effectiveDriver,
    model: effectiveModel,
  } = runtimeBindingSelection(runtime, { driver, model });
  const [binding, setBinding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const busy = !online || binding || runtime.operation?.phase === "running";
  const run = async (next: AiRuntimeActionInput["action"], selectedModel?: string) => {
    check(
      await action({
        environmentId: runtime.environmentId,
        input: {
          runtimeId: runtime.id,
          action: next,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(next === "cancel" && runtime.operation ? { operationId: runtime.operation.id } : {}),
        },
      }),
    );
  };
  return (
    <View className="gap-3 p-4 border-b border-border">
      <View className="flex-row flex-wrap items-start justify-between gap-2">
        <Text className="min-w-0 flex-1 basis-40 font-t3-bold text-foreground">{runtime.name}</Text>
        <Text className="max-w-full shrink text-xs text-foreground-muted">
          {!online
            ? "Node offline"
            : runtime.status === "available"
              ? "Running"
              : runtime.status === "authentication-required"
                ? "Authentication required"
                : runtime.installation === "absent"
                  ? "Not detected"
                  : "Unavailable"}
        </Text>
      </View>
      <Text selectable className="text-xs text-foreground-muted">
        {runtime.baseUrl}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {runtime.installation === "managed"
          ? "T3-managed"
          : runtime.installation === "external"
            ? "Existing installation / endpoint"
            : "No installation detected"}{" "}
        {runtime.version ?? ""} · {runtimeAvailability(runtime, online).label}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <Button label="Configure" disabled={busy} onPress={onEdit} />
        {runtime.id === "ollama-local" && (
          <>
            {runtime.installation === "absent" && (
              <Button
                primary
                label="Install Ollama"
                disabled={busy}
                onPress={() => {
                  void run("install");
                }}
              />
            )}
            {runtime.installation !== "absent" && runtime.status !== "available" && (
              <Button
                label="Start"
                disabled={busy}
                onPress={() => {
                  void run("start");
                }}
              />
            )}
            {runtime.ownedProcess && (
              <Button
                label="Stop"
                disabled={busy}
                onPress={() => {
                  void run("stop");
                }}
              />
            )}
            {runtime.installation === "managed" && (
              <>
                <Button
                  label="Update"
                  disabled={busy}
                  onPress={() => {
                    void run("update");
                  }}
                />
                <Button
                  label="Remove installation"
                  disabled={busy || runtime.ownedProcess}
                  onPress={() => {
                    void run("remove-installation");
                  }}
                />
              </>
            )}
          </>
        )}
        {runtime.networkBaseUrl && (
          <Button label="Use on another node" disabled={busy} onPress={onRemote} />
        )}
        {runtime.source === "configured" && (
          <Button
            label="Forget endpoint"
            disabled={busy}
            onPress={async () => {
              check(
                await remove({
                  environmentId: runtime.environmentId,
                  input: { runtimeId: runtime.id },
                }),
              );
            }}
          />
        )}
      </View>
      {runtime.operation && (
        <View className="gap-2">
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
            {runtime.operation.phase}: {runtime.operation.message}
            {runtime.operation.total
              ? ` · ${Math.round((runtime.operation.completed / runtime.operation.total) * 100)}%`
              : ""}
          </Text>
          {runtime.operation.phase === "running" && (
            <Button
              label="Cancel operation"
              disabled={!online}
              onPress={() => {
                void run("cancel");
              }}
            />
          )}
        </View>
      )}
      <Button
        label={`${expanded ? "Hide" : "Manage"} models (${runtime.models.length}) and agent binding`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <View className="gap-3">
          {runtime.models.length === 0 && (
            <Text className="text-sm text-foreground-muted">
              {runtime.status === "available"
                ? "No models discovered. Refresh the catalog or pull an Ollama model."
                : "Connect to the runtime to discover its models."}
            </Text>
          )}
          {runtime.models.map((item) => (
            <View key={item.id} className="gap-2">
              <Text className="text-sm text-foreground">{item.id}</Text>
              <Text className="text-xs text-foreground-muted">
                {item.capabilitiesKnown ? item.capabilities.join(", ") : "Capabilities unknown"}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={effectiveModel === item.id ? "Selected" : "Select"}
                  disabled={busy || runtime.status !== "available"}
                  onPress={() => setModel(item.id)}
                />
                {runtime.protocol === "ollama" && (
                  <Button
                    label="Remove model"
                    disabled={busy}
                    onPress={() =>
                      Alert.alert("Remove model?", item.id, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => {
                            void run("remove-model", item.id);
                          },
                        },
                      ])
                    }
                  />
                )}
              </View>
            </View>
          ))}
          {runtime.protocol === "ollama" && (
            <>
              <Field label="Model to pull" value={pull} onChange={setPull} />
              <Button
                label="Pull model"
                disabled={busy || !pull.trim() || runtime.status !== "available"}
                onPress={() => {
                  void run("pull", pull);
                }}
              />
            </>
          )}
          <Text className="text-sm font-t3-bold text-foreground">Agent binding</Text>
          <View className="flex-row flex-wrap gap-2">
            {drivers.map((item) => (
              <Button
                key={item}
                label={`${effectiveDriver === item ? "✓ " : ""}${item === "claudeAgent" ? "Claude Code" : item === "opencode" ? "OpenCode" : "Codex"}`}
                onPress={() => setDriver(item)}
              />
            ))}
          </View>
          <Text className="text-xs text-foreground-muted">
            Codex requires Responses API. Claude Code requires Anthropic Messages.
          </Text>
          <Field label="New provider instance ID" value={instanceId} onChange={setInstanceId} />
          <Button
            primary
            label={binding ? "Configuring…" : "Create agent binding"}
            disabled={
              busy ||
              !effectiveModel ||
              !effectiveDriver ||
              !isProviderId(instanceId) ||
              runtime.status !== "available"
            }
            onPress={async () => {
              if (busy || !effectiveDriver || !effectiveModel) return;
              setBinding(true);
              try {
                if (
                  check(
                    await bind({
                      environmentId: runtime.environmentId,
                      input: {
                        runtimeId: runtime.id,
                        instanceId: ProviderInstanceId.make(instanceId),
                        driver: effectiveDriver,
                        model: effectiveModel,
                      },
                    }),
                  )
                )
                  Alert.alert(
                    "Agent binding created",
                    "Choose the new provider and model in the chat selector.",
                  );
              } finally {
                setBinding(false);
              }
            }}
          />
        </View>
      )}
    </View>
  );
}

function EnvironmentRuntimes({
  environment,
  onEdit,
  onRemote,
}: {
  environment: EnvironmentPresentation;
  onEdit: (id: EnvironmentId, draft: AiRuntimeConfig) => void;
  onRemote: (runtime: AiRuntime) => void;
}) {
  const supported = environment.serverConfig?.environment.capabilities.aiRuntimes === true;
  const online = environment.connection.phase === "connected";
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.aiRuntimes({ environmentId: environment.environmentId, input: {} })
      : null,
  );
  const refresh = useAtomCommand(serverEnvironment.aiRuntimesList);
  return (
    <SettingsSection title={`${environment.label} · ${online ? "Online" : "Offline"}`} card>
      <View className="p-4 gap-3">
        <View className="flex-row flex-wrap gap-2">
          <Button
            label="Refresh"
            disabled={!online || !supported}
            onPress={async () => {
              check(
                await refresh({
                  environmentId: environment.environmentId,
                  input: { refresh: true },
                }),
              );
            }}
          />
          <Button
            label="Add Runtime"
            disabled={!online || !supported}
            onPress={() =>
              onEdit(environment.environmentId, {
                id: `runtime-${uuidv4()}`,
                name: "",
                runtimeKind: "openai-compatible",
                protocol: "openai",
                baseUrl: "",
                authentication: "none",
                configuredModels: [],
              })
            }
          />
        </View>
        {!supported && (
          <Text className="text-sm text-foreground-muted">
            Connect or update this environment to enable AI Runtimes.
          </Text>
        )}
        {query.error && <Text className="text-destructive">{query.error}</Text>}
        {supported && !query.data && !query.error && (
          <Text className="text-sm text-foreground-muted">
            {online ? "Discovering local runtimes…" : "Connect to this node to load its runtimes."}
          </Text>
        )}
      </View>
      {query.data?.runtimes.map((runtime) => (
        <RuntimeRow
          key={runtime.id}
          runtime={runtime}
          online={online}
          onEdit={() => onEdit(environment.environmentId, runtime)}
          onRemote={() => onRemote(runtime)}
        />
      ))}
    </SettingsSection>
  );
}

export function SettingsAiRuntimesRouteScreen() {
  const { environments } = useEnvironments();
  const insets = useSafeAreaInsets();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    draft: AiRuntimeConfig;
  } | null>(null);
  const [remote, setRemote] = useState<AiRuntime | null>(null);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 20 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-sm text-foreground-muted">
        Model endpoints on your connected environments. Existing agent providers work without
        configuring runtimes.
      </Text>
      {environments.map((environment) => (
        <EnvironmentRuntimes
          key={environment.environmentId}
          environment={environment}
          onEdit={(environmentId, draft) => setEditor({ environmentId, draft })}
          onRemote={setRemote}
        />
      ))}
      {remote && (
        <SettingsSection title="Select consuming node">
          <View className="gap-2 p-4">
            {environments
              .filter(
                (item) =>
                  item.environmentId !== remote.environmentId &&
                  item.connection.phase === "connected" &&
                  item.serverConfig?.environment.capabilities.aiRuntimes,
              )
              .map((item) => (
                <Button
                  key={item.environmentId}
                  label={item.label}
                  onPress={() => {
                    setEditor({
                      environmentId: item.environmentId,
                      draft: runtimeForConsumer(remote, `remote-${uuidv4()}`),
                    });
                    setRemote(null);
                  }}
                />
              ))}
            <Button label="Cancel" onPress={() => setRemote(null)} />
          </View>
        </SettingsSection>
      )}
      {editor && (
        <RuntimeEditor
          environmentId={editor.environmentId}
          initial={editor.draft}
          onClose={() => setEditor(null)}
        />
      )}
    </ScrollView>
  );
}
