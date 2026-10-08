import {
  emptyHookDraft,
  hookDraftToInput,
  hookToDraft,
  makeAutomationIdempotencyKey,
  summarizeHookFilter,
  summarizeHookTarget,
  type HookDraft,
} from "@t3tools/client-runtime/state/automation-drafts";
import {
  formatAutomationAge,
  hookSuppressedReasonLabel,
  presentHookDeliveryStatus,
} from "@t3tools/client-runtime/state/automation-presentation";
import type {
  EnvironmentId,
  Hook,
  HookDelivery,
  HookTestResult,
  Orchestrator,
} from "@t3tools/contracts";
import {
  FlaskConicalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { automationEnvironment } from "../../../state/automation";
import type { EnvironmentPresentation } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { AutomationStatusBadge } from "../../automation/AutomationStatus";
import { newActionNonce, reportAutomationFailure } from "../../automation/automationCommands";
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
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  automationEnvironmentAvailability,
  AUTOMATION_SETTINGS_ANCHORS,
  HOOK_DELIVERY_FILTERS,
  hookDeliveryActions,
  hookDeliveryFilterStatuses,
  type HookDeliveryFilterId,
} from "../automationSettings.logic";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settingsLayout";
import {
  AutomationEnvironmentSection,
  DraftErrors,
  Field,
  JsonField,
  QueryRows,
} from "./automationSettingsShared";

const OPERATOR_ALLOWLIST_NOTE =
  "Webhook and command destinations work only when whoever runs this environment's server allowed them (T3CODE_HOOK_WEBHOOK_ORIGINS for webhooks, T3CODE_HOOK_COMMANDS for commands). Otherwise the server refuses the hook.";

const TARGET_TYPE_LABELS: Record<string, string> = {
  orchestrator_inbox: "An orchestrator's inbox",
  cli_consumer: "A named CLI consumer",
  webhook: "A webhook (needs operator allowlist)",
  command: "A local command (needs operator allowlist)",
};

const DELIVERY_PAGE_SIZE = 50;
const EMPTY_ORCHESTRATORS: ReadonlyArray<Orchestrator> = [];

interface HookEditorTarget {
  readonly environmentId: EnvironmentId;
  readonly hook: Hook | null;
}

export function HooksSettingsSection({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [editor, setEditor] = useState<HookEditorTarget | null>(null);
  const [testing, setTesting] = useState<{ environmentId: EnvironmentId; hook: Hook } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, hook: Hook) => {
    setEditor({ environmentId, hook });
  }, []);
  const openTest = useCallback((environmentId: EnvironmentId, hook: Hook) => {
    setTesting({ environmentId, hook });
  }, []);
  const creatable = environments.filter(
    (environment) => automationEnvironmentAvailability(environment) === "ready",
  );
  const defaultEnvironment = creatable[0];
  return (
    <>
      <SettingsSection
        id={AUTOMATION_SETTINGS_ANCHORS.hooks}
        title="Hooks"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, hook: null })
            }
          >
            <PlusIcon className="size-3" />
            New hook
          </Button>
        }
      >
        <div className="space-y-8">
          {environments.map((environment) => (
            <AutomationEnvironmentSection
              key={environment.environmentId}
              environment={environment}
              showHeading={environments.length > 1}
              noun="hooks"
            >
              <HookRows
                environmentId={environment.environmentId}
                onEdit={openForEdit}
                onTest={openTest}
              />
              <HookDeliveries environmentId={environment.environmentId} />
            </AutomationEnvironmentSection>
          ))}
        </div>
      </SettingsSection>
      {editor ? (
        <HookEditorDialog
          key={`${editor.environmentId}:${editor.hook?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          hook={editor.hook}
          environments={creatable}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {testing ? (
        <HookTestDialog
          key={`${testing.environmentId}:${testing.hook.id}`}
          environmentId={testing.environmentId}
          hook={testing.hook}
          onClose={() => setTesting(null)}
        />
      ) : null}
    </>
  );
}

function useOrchestratorNames(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(
    automationEnvironment.orchestratorsLive({ environmentId, input: {} }),
  );
  const orchestrators = query.data?.orchestrators ?? EMPTY_ORCHESTRATORS;
  const nameOf = useCallback(
    (orchestratorId: string) =>
      orchestrators.find((entry) => entry.id === orchestratorId)?.name ?? null,
    [orchestrators],
  );
  return { orchestrators, nameOf };
}

function HookRows({
  environmentId,
  onEdit,
  onTest,
}: {
  readonly environmentId: EnvironmentId;
  readonly onEdit: (environmentId: EnvironmentId, hook: Hook) => void;
  readonly onTest: (environmentId: EnvironmentId, hook: Hook) => void;
}) {
  const query = useEnvironmentQuery(automationEnvironment.hooks({ environmentId, input: {} }));
  const { nameOf } = useOrchestratorNames(environmentId);
  return (
    <QueryRows
      query={query}
      noun="hooks"
      isEmpty={(data) => data.hooks.length === 0}
      emptyDescription="A hook delivers matching events somewhere, such as an orchestrator's inbox."
    >
      {(data) =>
        data.hooks.map((hook) => (
          <HookRow
            key={hook.id}
            environmentId={environmentId}
            hook={hook}
            orchestratorName={nameOf}
            onEdit={() => onEdit(environmentId, hook)}
            onTest={() => onTest(environmentId, hook)}
            onChanged={query.refresh}
          />
        ))
      }
    </QueryRows>
  );
}

function HookRow({
  environmentId,
  hook,
  orchestratorName,
  onEdit,
  onTest,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly hook: Hook;
  readonly orchestratorName: (orchestratorId: string) => string | null;
  readonly onEdit: () => void;
  readonly onTest: () => void;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const setEnabled = useAtomCommand(automationEnvironment.setHookEnabled, {
    label: "hook set enabled",
    reportFailure: false,
  });
  const remove = useAtomCommand(automationEnvironment.deleteHook, {
    label: "hook delete",
    reportFailure: false,
  });
  const target = summarizeHookTarget(hook.target, orchestratorName);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const result = await setEnabled({
      environmentId,
      input: { hookId: hook.id, enabled: !hook.enabled },
    });
    setBusy(false);
    if (reportAutomationFailure("Could not update the hook", result) === null) onChanged();
  };
  const deleteHook = async () => {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete hook "${hook.name}"? Deliveries it still holds are dropped.`,
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { hookId: hook.id } });
    setBusy(false);
    if (reportAutomationFailure("Could not delete the hook", result) === null) onChanged();
  };

  return (
    <SettingsRow
      title={hook.name}
      description={`When ${summarizeHookFilter(hook.filter)} → ${target.label}`}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {hook.enabled ? "Enabled" : "Disabled"} ·{" "}
            {hook.deliveryMode === "batch"
              ? `batched every ${(hook.batchWindowMs ?? 0) / 1_000}s`
              : "one delivery per event"}
          </span>
          {target.needsOperatorAllowlist ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="warning">
                    <ShieldAlertIcon aria-hidden />
                    Needs operator allowlist
                  </Badge>
                }
              />
              <TooltipPopup side="top">{OPERATOR_ALLOWLIST_NOTE}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={hook.enabled}
            disabled={busy}
            aria-label={`Enable ${hook.name}`}
            onCheckedChange={() => void toggle()}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${hook.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem onClick={onTest}>
                <FlaskConicalIcon />
                Test (sends nothing)
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void deleteHook()}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function HookDeliveries({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [filter, setFilter] = useState<HookDeliveryFilterId>("attention");
  const nowMs = useRelativeTimeTick(60_000);
  const statuses = hookDeliveryFilterStatuses(filter);
  const input = useMemo(
    () => ({
      ...(statuses === null ? {} : { statuses: [...statuses] }),
      limit: DELIVERY_PAGE_SIZE,
    }),
    [statuses],
  );
  const deliveries = useEnvironmentQuery(
    automationEnvironment.hookDeliveries({ environmentId, input }),
  );
  const hooks = useEnvironmentQuery(automationEnvironment.hooks({ environmentId, input: {} }));
  const hookName = (delivery: HookDelivery) =>
    hooks.data?.hooks.find((hook) => hook.id === delivery.hookId)?.name ?? delivery.hookId;
  return (
    <>
      <SettingsRow
        title="Deliveries"
        description="Delivered means stored at the destination, not that the work it triggers is done."
        control={
          <ToggleGroup
            aria-label="Deliveries to show"
            value={[filter]}
            onValueChange={(values) => {
              const next = HOOK_DELIVERY_FILTERS.find((entry) => entry.id === values[0]);
              if (next) setFilter(next.id);
            }}
          >
            {HOOK_DELIVERY_FILTERS.map((entry) => (
              <Toggle key={entry.id} value={entry.id}>
                {entry.label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
      <QueryRows
        query={deliveries}
        noun="deliveries"
        isEmpty={(data) => data.deliveries.length === 0}
        emptyDescription="Nothing matches this filter."
      >
        {(data) => (
          <>
            {data.deliveries.map((delivery) => (
              <HookDeliveryRow
                key={delivery.id}
                environmentId={environmentId}
                delivery={delivery}
                hookName={hookName(delivery)}
                nowMs={nowMs}
                onChanged={deliveries.refresh}
              />
            ))}
            {data.deliveries.length >= DELIVERY_PAGE_SIZE ? (
              <SettingsRow
                title="Partial list"
                description={`Showing the first ${DELIVERY_PAGE_SIZE} deliveries the server returned. Narrow the filter to see the rest.`}
                role="status"
              />
            ) : null}
          </>
        )}
      </QueryRows>
    </>
  );
}

function HookDeliveryRow({
  environmentId,
  delivery,
  hookName,
  nowMs,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly delivery: HookDelivery;
  readonly hookName: string;
  readonly nowMs: number;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const redeliver = useAtomCommand(automationEnvironment.redeliverHookDelivery, {
    label: "hook redeliver",
    reportFailure: false,
  });
  const dismiss = useAtomCommand(automationEnvironment.dismissHookDelivery, {
    label: "hook dismiss delivery",
    reportFailure: false,
  });
  const status = presentHookDeliveryStatus(delivery.status);
  const actions = hookDeliveryActions(delivery.status);
  const suppressed = hookSuppressedReasonLabel(delivery.suppressedReason);
  const act = async (action: "redeliver" | "dismiss") => {
    if (busy) return;
    setBusy(true);
    const command = action === "redeliver" ? redeliver : dismiss;
    const result = await command({ environmentId, input: { deliveryId: delivery.id } });
    setBusy(false);
    if (
      reportAutomationFailure(
        action === "redeliver" ? "Could not redeliver" : "Could not dismiss the delivery",
        result,
      ) === null
    ) {
      onChanged();
    }
  };
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{hookName}</span>
          <AutomationStatusBadge status={status} />
        </span>
      }
      description={
        delivery.lastError ?? (suppressed ? `Held back because ${suppressed}.` : undefined)
      }
      status={
        <span>
          {delivery.eventIds.length} {delivery.eventIds.length === 1 ? "event" : "events"} ·{" "}
          {delivery.attemptCount} {delivery.attemptCount === 1 ? "attempt" : "attempts"} · updated{" "}
          {formatAutomationAge(Math.max(0, nowMs - Date.parse(delivery.updatedAt)))}
        </span>
      }
      control={
        actions.canRedeliver || actions.canDismiss ? (
          <div className="flex items-center gap-2">
            {actions.canRedeliver ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act("redeliver")}
              >
                <RotateCcwIcon />
                Redeliver
              </Button>
            ) : null}
            {actions.canDismiss ? (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Dismiss delivery of ${hookName}`}
                onClick={() => void act("dismiss")}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    />
  );
}

function HookTestDialog({
  environmentId,
  hook,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly hook: Hook;
  readonly onClose: () => void;
}) {
  const test = useAtomCommand(automationEnvironment.testHook, {
    label: "hook test",
    reportFailure: false,
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HookTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    // No `deliver`: a test from here is always a dry run.
    const outcome = await test({ environmentId, input: { hookId: hook.id } });
    setRunning(false);
    if (outcome._tag === "Success") {
      setResult(outcome.value);
      return;
    }
    const failure = reportAutomationFailure("Could not test the hook", outcome);
    if (failure !== null) setError(failure.message);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Test “{hook.name}”</DialogTitle>
          <DialogDescription>
            Matches the hook against recent events and shows what it would send. Nothing is sent.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {result === null && error === null ? (
              <p className="text-sm text-muted-foreground">
                {running ? "Testing…" : "Run the test to see what this hook would deliver."}
              </p>
            ) : null}
            {error !== null ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {result !== null ? (
              <>
                <p className="text-sm" role="status">
                  {result.matched.length === 0
                    ? "No recent event matches this hook."
                    : `${result.matched.length} recent ${
                        result.matched.length === 1 ? "event matches" : "events match"
                      }.`}{" "}
                  {result.dryRun ? "Nothing was sent." : "The server reports this was sent."}
                </p>
                {result.matched.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {[...new Set(result.matched.map((entry) => entry.event.type))].join(", ")}
                  </p>
                ) : null}
                {result.preview !== null ? (
                  <Field label="Would be sent" hint="Secrets are redacted by the server">
                    <Textarea
                      variant="code"
                      readOnly
                      aria-label="Delivery preview"
                      value={JSON.stringify(result.preview, null, 2)}
                    />
                  </Field>
                ) : null}
              </>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={running} />}>
            Close
          </DialogClose>
          <Button size="sm" disabled={running} onClick={() => void run()}>
            {result === null ? "Run dry run" : "Run again"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function HookEditorDialog({
  initialEnvironmentId,
  hook,
  environments,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly hook: Hook | null;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const connected =
    environment !== undefined && automationEnvironmentAvailability(environment) === "ready";
  const hooks = useEnvironmentQuery(automationEnvironment.hooks({ environmentId, input: {} }));
  const { orchestrators } = useOrchestratorNames(environmentId);
  const upsert = useAtomCommand(automationEnvironment.upsertHook, {
    label: "hook upsert",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<HookDraft>(() =>
    hook ? hookToDraft(hook) : emptyHookDraft({}),
  );
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const actionNonce = useRef(newActionNonce());
  const update = (patch: Partial<HookDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const latest =
    hook === null ? null : (hooks.data?.hooks.find((entry) => entry.id === hook.id) ?? null);
  const selectedOrchestratorId = draft.orchestratorId || orchestrators[0]?.id || "";
  const needsAllowlist = draft.targetType === "webhook" || draft.targetType === "command";

  const submit = async () => {
    if (submissionPending.current || saving || !connected) return;
    const result = hookDraftToInput(
      { ...draft, orchestratorId: selectedOrchestratorId },
      { idempotencyKey: makeAutomationIdempotencyKey("web-hook-upsert", actionNonce.current) },
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
      const error = reportAutomationFailure("Could not save the hook", outcome);
      if (error !== null) {
        setErrors([error.message]);
        setStale(error.stale);
        if (error.stale) hooks.refresh();
      }
      return;
    }
    hooks.refresh();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{hook ? "Edit hook" : "New hook"}</DialogTitle>
          <DialogDescription>
            When an event matches, deliver it somewhere. Hooks survive restarts and retry on their
            own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Runs on" htmlFor="hook-environment">
                <Select
                  value={environmentId}
                  disabled={hook !== null || saving}
                  onValueChange={(id) => {
                    const next = environments.find((entry) => entry.environmentId === id);
                    if (!next) return;
                    setEnvironmentId(next.environmentId);
                    update({ orchestratorId: "" });
                  }}
                >
                  <SelectTrigger id="hook-environment" size="sm">
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
              <Field label="Name" htmlFor="hook-name">
                <Input
                  id="hook-name"
                  placeholder="e.g. Tell the orchestrator when work ends"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Event types"
              hint="One per line. task.reported, or task.* for a group. Empty matches every event."
              htmlFor="hook-event-types"
            >
              <Textarea
                id="hook-event-types"
                variant="code"
                spellCheck={false}
                value={draft.eventTypes}
                onChange={(event) => update({ eventTypes: event.target.value })}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Project IDs" hint="Optional" htmlFor="hook-project-ids">
                <Input
                  id="hook-project-ids"
                  placeholder="Any project"
                  value={draft.projectIds.replace(/\n/g, ", ")}
                  onChange={(event) => update({ projectIds: event.target.value })}
                />
              </Field>
              <Field label="Thread IDs" hint="Optional" htmlFor="hook-thread-ids">
                <Input
                  id="hook-thread-ids"
                  placeholder="Any thread"
                  value={draft.threadIds.replace(/\n/g, ", ")}
                  onChange={(event) => update({ threadIds: event.target.value })}
                />
              </Field>
              <Field label="Orchestrator IDs" hint="Optional" htmlFor="hook-orchestrator-ids">
                <Input
                  id="hook-orchestrator-ids"
                  placeholder="Any orchestrator"
                  value={draft.orchestratorIds.replace(/\n/g, ", ")}
                  onChange={(event) => update({ orchestratorIds: event.target.value })}
                />
              </Field>
            </div>

            <Field label="Deliver to" htmlFor="hook-target-type">
              <Select
                value={draft.targetType}
                onValueChange={(value) => update({ targetType: value ?? draft.targetType })}
              >
                <SelectTrigger id="hook-target-type" size="sm">
                  <SelectValue>
                    {TARGET_TYPE_LABELS[draft.targetType] ?? draft.targetType}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {Object.keys(TARGET_TYPE_LABELS).map((type) => (
                    <SelectItem key={type} value={type}>
                      {TARGET_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            {needsAllowlist ? (
              <p className="text-xs text-warning" role="note">
                {OPERATOR_ALLOWLIST_NOTE}
              </p>
            ) : null}

            {draft.targetType === "orchestrator_inbox" ? (
              <Field label="Orchestrator" htmlFor="hook-orchestrator">
                <Select
                  value={selectedOrchestratorId}
                  onValueChange={(value) => update({ orchestratorId: value ?? "" })}
                >
                  <SelectTrigger id="hook-orchestrator" size="sm">
                    <SelectValue placeholder="Select an orchestrator">
                      {orchestrators.find((entry) => entry.id === selectedOrchestratorId)?.name ??
                        (selectedOrchestratorId || undefined)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {orchestrators.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : null}
            {draft.targetType === "cli_consumer" ? (
              <Field
                label="Consumer name"
                hint="Read it with t3 events watch --consumer"
                htmlFor="hook-consumer"
              >
                <Input
                  id="hook-consumer"
                  placeholder="my-script"
                  value={draft.consumerId}
                  onChange={(event) => update({ consumerId: event.target.value })}
                />
              </Field>
            ) : null}
            {draft.targetType === "webhook" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="URL" htmlFor="hook-webhook-url">
                  <Input
                    id="hook-webhook-url"
                    placeholder="https://example.com/hook"
                    value={draft.webhookUrl}
                    onChange={(event) => update({ webhookUrl: event.target.value })}
                  />
                </Field>
                <Field
                  label="Signing secret name"
                  hint="The secret stays on the server"
                  htmlFor="hook-webhook-secret"
                >
                  <Input
                    id="hook-webhook-secret"
                    placeholder="hook-secret"
                    value={draft.webhookSecretRef}
                    onChange={(event) => update({ webhookSecretRef: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            {draft.targetType === "command" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Executable" hint="Absolute path" htmlFor="hook-command-executable">
                    <Input
                      id="hook-command-executable"
                      placeholder="/usr/local/bin/notify"
                      value={draft.commandExecutable}
                      onChange={(event) => update({ commandExecutable: event.target.value })}
                    />
                  </Field>
                  <Field label="Working directory" hint="Optional" htmlFor="hook-command-cwd">
                    <Input
                      id="hook-command-cwd"
                      value={draft.commandCwd}
                      onChange={(event) => update({ commandCwd: event.target.value })}
                    />
                  </Field>
                </div>
                <Field
                  label="Arguments"
                  hint="One per line. The event arrives as JSON on stdin."
                  htmlFor="hook-command-args"
                >
                  <Textarea
                    id="hook-command-args"
                    variant="code"
                    spellCheck={false}
                    value={draft.commandArgs}
                    onChange={(event) => update({ commandArgs: event.target.value })}
                  />
                </Field>
                <Field
                  label="Environment variables to pass"
                  hint="Names only. Nothing else is inherited."
                  htmlFor="hook-command-env"
                >
                  <Input
                    id="hook-command-env"
                    placeholder="HOME, PATH"
                    value={draft.commandEnvAllowlist.replace(/\n/g, ", ")}
                    onChange={(event) => update({ commandEnvAllowlist: event.target.value })}
                  />
                </Field>
              </>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Delivery" htmlFor="hook-delivery-mode">
                <Select
                  value={draft.deliveryMode}
                  onValueChange={(value) => update({ deliveryMode: value ?? draft.deliveryMode })}
                >
                  <SelectTrigger id="hook-delivery-mode" size="sm">
                    <SelectValue>
                      {draft.deliveryMode === "batch" ? "Group events together" : "One per event"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="batch">Group events together</SelectItem>
                    <SelectItem value="each">One per event</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
              {draft.deliveryMode === "batch" ? (
                <Field label="Batch window" hint="Seconds" htmlFor="hook-batch-window">
                  <Input
                    id="hook-batch-window"
                    type="number"
                    nativeInput
                    min={0}
                    step="any"
                    value={draft.batchWindowSeconds}
                    onChange={(event) => update({ batchWindowSeconds: event.target.value })}
                  />
                </Field>
              ) : null}
            </div>

            <JsonField
              id="hook-policy"
              label="Delivery policy"
              hint="JSON: retry, timeoutMs, priority, cooldownMs, maxDeliveriesPerTask"
              value={draft.policyJson}
              onChange={(policyJson) => update({ policyJson })}
            />

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Enabled</p>
                <p className="text-sm text-muted-foreground">
                  A new hook starts from now; it does not replay earlier events.
                </p>
              </div>
              <Switch
                aria-label="Enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>

            <DraftErrors errors={errors} />
            {stale && latest !== null ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraft(hookToDraft(latest));
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
          <Button size="sm" disabled={saving || !connected} onClick={() => void submit()}>
            {hook ? "Save hook" : "Create hook"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
