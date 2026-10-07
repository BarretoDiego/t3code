import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  emptyOrchestratorDraft,
  makeAutomationIdempotencyKey,
  orchestratorDraftToInput,
  orchestratorToDraft,
  type OrchestratorDraft,
} from "@t3tools/client-runtime/state/automation-drafts";
import {
  joinOrchestratorsToThreads,
  type OrchestratorListRow,
  orchestratorStateActions,
  presentObservation,
  resolveEnvironmentReachability,
} from "@t3tools/client-runtime/state/automation-presentation";
import {
  type EnvironmentId,
  type Orchestrator,
  type OrchestratorId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BanIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../../hooks/useSettings";
import { ensureLocalApi } from "../../../localApi";
import { getCustomModelOptionsByInstance } from "../../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { automationEnvironment } from "../../../state/automation";
import { useProjects, useThreadShells } from "../../../state/entities";
import { type EnvironmentPresentation, useEnvironments } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { AutomationStatusBadge, ObservationLabel } from "../../automation/AutomationStatus";
import { newActionNonce, reportAutomationFailure } from "../../automation/automationCommands";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../../chat/runtimeModeConfig";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import {
  automationEnvironmentAvailability,
  AUTOMATION_SETTINGS_ANCHORS,
} from "../automationSettings.logic";
// An orchestrator belongs to one project, like a scheduled task, so both follow the same scope rule.
import {
  matchesScheduledTaskScope,
  scheduledTaskDefaultModel,
} from "../scheduledTasksSettings.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "../settingsLayout";
import { useSettingsScope } from "../SettingsScopeContext";
import {
  AutomationEnvironmentSection,
  DraftErrors,
  Field,
  JsonField,
  QueryRows,
} from "./automationSettingsShared";

interface OrchestratorEditorTarget {
  readonly environmentId: EnvironmentId;
  readonly orchestrator: Orchestrator | null;
}

export function OrchestratorsSettingsSection({
  environments,
  target,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly target: {
    readonly environmentId?: EnvironmentId;
    readonly orchestratorId?: OrchestratorId;
  };
}) {
  const [editor, setEditor] = useState<OrchestratorEditorTarget | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, orchestrator: Orchestrator) => {
    setEditor({ environmentId, orchestrator });
  }, []);
  const creatable = environments.filter(
    (environment) => automationEnvironmentAvailability(environment) === "ready",
  );
  const defaultEnvironment = creatable[0];
  return (
    <>
      <SettingsSection
        id={AUTOMATION_SETTINGS_ANCHORS.orchestrators}
        title="Orchestrators"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, orchestrator: null })
            }
          >
            <PlusIcon className="size-3" />
            New orchestrator
          </Button>
        }
      >
        <div className="space-y-8">
          {environments.map((environment) => (
            <AutomationEnvironmentSection
              key={environment.environmentId}
              environment={environment}
              showHeading={environments.length > 1}
              noun="orchestrators"
            >
              <OrchestratorRows
                environmentId={environment.environmentId}
                linkedOrchestratorId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  environment.environmentId
                    ? target.orchestratorId
                    : undefined
                }
                onEdit={openForEdit}
              />
            </AutomationEnvironmentSection>
          ))}
        </div>
      </SettingsSection>
      {editor ? (
        <OrchestratorEditorDialog
          key={`${editor.environmentId}:${editor.orchestrator?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          orchestrator={editor.orchestrator}
          environments={creatable}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function OrchestratorRows({
  environmentId,
  linkedOrchestratorId,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly linkedOrchestratorId: OrchestratorId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, orchestrator: Orchestrator) => void;
}) {
  const { scope } = useSettingsScope();
  const nowMs = useRelativeTimeTick(60_000);
  const threads = useThreadShells();
  const query = useEnvironmentQuery(
    automationEnvironment.orchestratorsLive({ environmentId, input: {} }),
  );
  const rows = useMemo(
    () =>
      query.data === null
        ? null
        : joinOrchestratorsToThreads({
            snapshot: { environmentId, orchestrators: query.data.orchestrators },
            threads,
          }).filter((row) =>
            matchesScheduledTaskScope(scope, environmentId, row.view.orchestrator.projectId),
          ),
    [environmentId, query.data, scope, threads],
  );
  const linked = rows?.find((row) => row.view.orchestrator.id === linkedOrchestratorId);
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linked?.view.hostedHere) {
      openedLink.current = true;
      onEdit(environmentId, linked.view.orchestrator);
    }
  }, [environmentId, linked, onEdit]);
  return (
    <QueryRows
      query={{ ...query, data: rows }}
      noun="orchestrators"
      isEmpty={(data) => data.length === 0}
      emptyDescription="No orchestrator matches this environment and project selection."
    >
      {(data) =>
        data.map((row) => (
          <OrchestratorRow key={row.view.key} row={row} nowMs={nowMs} onEdit={onEdit} />
        ))
      }
    </QueryRows>
  );
}

function OrchestratorRow({
  row,
  nowMs,
  onEdit,
}: {
  readonly row: OrchestratorListRow<{ readonly id: string; readonly title: string }>;
  readonly nowMs: number;
  readonly onEdit: (environmentId: EnvironmentId, orchestrator: Orchestrator) => void;
}) {
  const { view } = row;
  const { orchestrator, environmentId } = view;
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const host = environments.find((entry) => entry.environmentId === orchestrator.hostEnvironmentId);
  const [busy, setBusy] = useState(false);
  const setState = useAtomCommand(automationEnvironment.setOrchestratorState, {
    label: "orchestrator set state",
    reportFailure: false,
  });
  const remove = useAtomCommand(automationEnvironment.deleteOrchestrator, {
    label: "orchestrator delete",
    reportFailure: false,
  });
  const actions = orchestratorStateActions(view);

  const changeState = async (desiredState: Orchestrator["desiredState"]) => {
    if (busy) return;
    setBusy(true);
    const result = await setState({
      environmentId,
      input: { orchestratorId: orchestrator.id, desiredState },
    });
    setBusy(false);
    reportAutomationFailure("Could not change the orchestrator", result);
  };
  const deleteOrchestrator = async () => {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete orchestrator "${orchestrator.name}"? Its inbox and hooks that deliver to it stop working. Its thread is kept.`,
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { orchestratorId: orchestrator.id } });
    setBusy(false);
    reportAutomationFailure("Could not delete the orchestrator", result);
  };
  const thread = row.thread;

  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{orchestrator.name}</span>
          <Badge variant="outline">{orchestrator.scope === "global" ? "Global" : "Local"}</Badge>
          <AutomationStatusBadge status={row.state} />
        </span>
      }
      description={
        orchestrator.stateReason ??
        (row.threadLink === "none"
          ? "A read-only copy. Its thread lives in the environment that hosts it."
          : row.threadLink === "missing"
            ? "Its thread is not loaded here; it may be archived."
            : `Thread: ${thread?.title ?? ""}`)
      }
      status={
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {view.hostedHere
              ? "Hosted here"
              : `Hosted on ${host?.label ?? orchestrator.hostEnvironmentId}`}{" "}
            · {orchestrator.modelSelection.model} · {orchestrator.inboxPending} in inbox
          </span>
          {view.hostedHere ? null : (
            <ObservationLabel
              observation={presentObservation({
                observedAt: orchestrator.observedAt,
                nowMs,
                reachable: resolveEnvironmentReachability({
                  clientConnectionPhase: host?.connection.phase ?? null,
                }),
              })}
            />
          )}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          {actions.canPause ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void changeState("paused")}
            >
              <PauseIcon />
              Pause
            </Button>
          ) : null}
          {actions.canResume ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void changeState("active")}
            >
              <PlayIcon />
              Resume
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${orchestrator.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {thread !== null ? (
                <MenuItem
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(environmentId, orchestrator.threadId!),
                      ),
                    })
                  }
                >
                  <MessageSquareIcon />
                  Open thread
                </MenuItem>
              ) : null}
              {view.hostedHere ? (
                <>
                  <MenuItem onClick={() => onEdit(environmentId, orchestrator)}>
                    <PencilIcon />
                    Edit
                  </MenuItem>
                  {actions.canDisable ? (
                    <MenuItem onClick={() => void changeState("disabled")}>
                      <BanIcon />
                      Disable
                    </MenuItem>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem onClick={() => void deleteOrchestrator()}>
                    <Trash2Icon />
                    Delete
                  </MenuItem>
                </>
              ) : (
                <MenuItem disabled>Edit it from the environment that hosts it</MenuItem>
              )}
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function splitModelKey(value: string): { instanceId: ProviderInstanceId; model: string } | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function OrchestratorEditorDialog({
  initialEnvironmentId,
  orchestrator,
  environments,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly orchestrator: Orchestrator | null;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const { scope } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const connected =
    environment !== undefined && automationEnvironmentAvailability(environment) === "ready";
  const live = useEnvironmentQuery(
    automationEnvironment.orchestratorsLive({ environmentId, input: {} }),
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const upsert = useAtomCommand(automationEnvironment.upsertOrchestrator, {
    label: "orchestrator upsert",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<OrchestratorDraft>(() =>
    orchestrator ? orchestratorToDraft(orchestrator) : emptyOrchestratorDraft({}),
  );
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  // One key for this dialog's save, however many times it is retried.
  const actionNonce = useRef(newActionNonce());
  const update = (patch: Partial<OrchestratorDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const activeSelection = draft.modelKey
    ? splitModelKey(draft.modelKey)
    : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("");
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );
  const latest =
    orchestrator === null
      ? null
      : (live.data?.orchestrators.find((entry) => entry.id === orchestrator.id) ?? null);
  const removedElsewhere = orchestrator !== null && live.data !== null && latest === null;

  const submit = async () => {
    if (submissionPending.current || saving || !connected || removedElsewhere) return;
    const result = orchestratorDraftToInput(
      {
        ...draft,
        projectId: selectedProjectId,
        modelKey: activeSelection ? `${activeSelection.instanceId}:${activeSelection.model}` : "",
      },
      {
        idempotencyKey: makeAutomationIdempotencyKey(
          "web-orchestrator-upsert",
          actionNonce.current,
        ),
      },
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    setErrors([]);
    const outcome = await upsert({ environmentId, input: result.input });
    setSaving(false);
    if (outcome._tag === "Failure") {
      submissionPending.current = false;
      const error = reportAutomationFailure("Could not save the orchestrator", outcome);
      if (error !== null) {
        setErrors([error.message]);
        setStale(error.stale);
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{orchestrator ? "Edit orchestrator" : "New orchestrator"}</DialogTitle>
          <DialogDescription>
            A persistent agent with its own thread, inbox, permissions and budget. It takes a turn
            only when its inbox has something to act on.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            {removedElsewhere ? (
              <p className="text-sm text-destructive" role="status">
                This orchestrator no longer exists.
              </p>
            ) : null}
            <Field label="Runs on" htmlFor="orchestrator-environment">
              <Select
                value={environmentId}
                disabled={orchestrator !== null || saving}
                onValueChange={(id) => {
                  const next = environments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  update({ projectId: "", modelKey: "", baseModelSelection: null });
                }}
              >
                <SelectTrigger id="orchestrator-environment" size="sm">
                  <SelectValue>{environment?.label ?? "Unavailable environment"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="orchestrator-name">
                <Input
                  id="orchestrator-name"
                  placeholder="e.g. Release captain"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
              <Field label="Scope" htmlFor="orchestrator-scope">
                <Select
                  value={draft.scope}
                  onValueChange={(value) => update({ scope: value ?? "local" })}
                >
                  <SelectTrigger id="orchestrator-scope" size="sm">
                    <SelectValue>
                      {draft.scope === "global"
                        ? "Global: may address peers"
                        : "Local: this environment"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="local">Local: this environment</SelectItem>
                    <SelectItem value="global">Global: may address peers</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" htmlFor="orchestrator-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) => update({ projectId: projectId ?? "" })}
                >
                  <SelectTrigger id="orchestrator-project" size="sm">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title ?? (selectedProjectId || undefined)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Runtime mode" htmlFor="orchestrator-runtime-mode">
                <Select
                  value={draft.runtimeMode}
                  onValueChange={(value) => update({ runtimeMode: value ?? draft.runtimeMode })}
                >
                  <SelectTrigger id="orchestrator-runtime-mode" size="sm">
                    <SelectValue>
                      {runtimeModeOptions.includes(draft.runtimeMode as never)
                        ? runtimeModeConfig[draft.runtimeMode as keyof typeof runtimeModeConfig]
                            .label
                        : draft.runtimeMode}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeModeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            <Field label="Model">
              <ProviderModelPicker
                disabled={saving || !connected}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  update({ modelKey: `${instanceId}:${model}` })
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Agent profile" hint="Optional slug" htmlFor="orchestrator-profile">
                <Input
                  id="orchestrator-profile"
                  placeholder="e.g. reviewer"
                  value={draft.profile}
                  onChange={(event) => update({ profile: event.target.value })}
                />
              </Field>
              <Field label="Batch window" hint="Seconds" htmlFor="orchestrator-batch-window">
                <Input
                  id="orchestrator-batch-window"
                  type="number"
                  nativeInput
                  min={0}
                  step="any"
                  value={draft.batchWindowSeconds}
                  onChange={(event) => update({ batchWindowSeconds: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Instructions"
              hint="Added to the built-in orchestrator instructions"
              htmlFor="orchestrator-instructions"
            >
              <Textarea
                id="orchestrator-instructions"
                placeholder="What is this orchestrator responsible for?"
                value={draft.instructions}
                onChange={(event) => update({ instructions: event.target.value })}
              />
            </Field>

            <JsonField
              id="orchestrator-policy"
              label="Permissions and limits"
              hint="JSON: permissions, budget, responsibilityOrder"
              value={draft.policyJson}
              onChange={(policyJson) => update({ policyJson })}
            />
            <p className="text-xs text-muted-foreground">
              A budget value of <code>null</code> means no limit. Approvals stay with you unless{" "}
              <code>preAuthorizedApprovals</code> names a kind.
            </p>

            <DraftErrors errors={errors} />
            {stale && latest !== null ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(orchestratorToDraft(latest));
                  setErrors([]);
                  setStale(false);
                }}
              >
                Reload the current version
              </Button>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={saving || !connected || removedElsewhere}
            onClick={() => void submit()}
          >
            {orchestrator ? "Save orchestrator" : "Create orchestrator"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
