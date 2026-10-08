import {
  emptyExecutionNodeDraft,
  executionNodeDraftToInput,
  executionNodeToDraft,
  type ExecutionNodeDraft,
} from "@t3tools/client-runtime/state/automation-drafts";
import {
  formatAutomationAge,
  presentJobStatus,
  presentNodeAvailability,
  presentObservation,
} from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, ExecutionNode, Job } from "@t3tools/contracts";
import {
  ActivityIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ScrollTextIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { ensureLocalApi } from "../../../localApi";
import { automationEnvironment } from "../../../state/automation";
import type { EnvironmentPresentation } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { AutomationStatusBadge, ObservationLabel } from "../../automation/AutomationStatus";
import { reportAutomationFailure } from "../../automation/automationCommands";
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
import {
  automationEnvironmentAvailability,
  AUTOMATION_SETTINGS_ANCHORS,
  tailLogText,
} from "../automationSettings.logic";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settingsLayout";
import {
  AutomationEnvironmentSection,
  DraftErrors,
  Field,
  QueryRows,
} from "./automationSettingsShared";

const JOB_PAGE_SIZE = 20;
const LOG_TAIL_BYTES = 16 * 1024;
const LOG_TAIL_LINES = 200;
/** A probe says what a node looked like then; after this it is shown as old. */
const PROBE_STALE_AFTER_MS = 15 * 60_000;

interface NodeEditorTarget {
  readonly environmentId: EnvironmentId;
  readonly node: ExecutionNode | null;
}

export function NodesSettingsSection({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [editor, setEditor] = useState<NodeEditorTarget | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, node: ExecutionNode) => {
    setEditor({ environmentId, node });
  }, []);
  const creatable = environments.filter(
    (environment) => automationEnvironmentAvailability(environment) === "ready",
  );
  const defaultEnvironment = creatable[0];
  return (
    <>
      <SettingsSection
        id={AUTOMATION_SETTINGS_ANCHORS.nodes}
        title="Nodes and jobs"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, node: null })
            }
          >
            <PlusIcon className="size-3" />
            Add node
          </Button>
        }
      >
        <div className="space-y-8">
          {environments.map((environment) => (
            <AutomationEnvironmentSection
              key={environment.environmentId}
              environment={environment}
              showHeading={environments.length > 1}
              noun="nodes and jobs"
            >
              <NodeRows environmentId={environment.environmentId} onEdit={openForEdit} />
              <JobRows environmentId={environment.environmentId} />
            </AutomationEnvironmentSection>
          ))}
        </div>
      </SettingsSection>
      {editor ? (
        <NodeEditorDialog
          key={`${editor.environmentId}:${editor.node?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          node={editor.node}
          environments={creatable}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function NodeRows({
  environmentId,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly onEdit: (environmentId: EnvironmentId, node: ExecutionNode) => void;
}) {
  const nowMs = useRelativeTimeTick(60_000);
  const query = useEnvironmentQuery(automationEnvironment.nodes({ environmentId, input: {} }));
  return (
    <QueryRows
      query={query}
      noun="nodes"
      isEmpty={(data) => data.nodes.length === 0}
      emptyDescription="A node is a machine this environment can run commands on."
    >
      {(data) =>
        data.nodes.map((node) => (
          <NodeRow
            key={node.id}
            environmentId={environmentId}
            node={node}
            nowMs={nowMs}
            onEdit={() => onEdit(environmentId, node)}
            onChanged={query.refresh}
          />
        ))
      }
    </QueryRows>
  );
}

function describeTransport(node: ExecutionNode): string {
  const transport = node.transport;
  // Read through a string so a transport from a newer server still gets a label.
  const type: string = transport.type;
  if (transport.type === "local") return "This environment's machine";
  if (transport.type === "ssh") {
    return `SSH ${transport.target}${transport.port === undefined ? "" : `:${transport.port}`}`;
  }
  return type;
}

function NodeRow({
  environmentId,
  node,
  nowMs,
  onEdit,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: ExecutionNode;
  readonly nowMs: number;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"probe" | "remove" | null>(null);
  const probe = useAtomCommand(automationEnvironment.probeNode, {
    label: "node probe",
    reportFailure: false,
  });
  const remove = useAtomCommand(automationEnvironment.removeNode, {
    label: "node remove",
    reportFailure: false,
  });
  const availability = presentNodeAvailability(node.availability.status);
  const runProbe = async () => {
    if (busy !== null) return;
    setBusy("probe");
    const result = await probe({ environmentId, input: { nodeId: node.id } });
    setBusy(null);
    if (reportAutomationFailure("Could not probe the node", result) === null) onChanged();
  };
  const removeNode = async () => {
    if (busy !== null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(`Remove node "${node.label}"?`);
    if (!confirmed) return;
    setBusy("remove");
    const result = await remove({ environmentId, input: { nodeId: node.id } });
    setBusy(null);
    if (reportAutomationFailure("Could not remove the node", result) === null) onChanged();
  };
  const platform = [node.availability.os, node.availability.arch].filter(Boolean).join(" ");
  const tools = node.availability.tools
    .map((tool) => (tool.version ? `${tool.name} ${tool.version}` : tool.name))
    .join(", ");
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{node.label}</span>
          <AutomationStatusBadge status={availability} />
          {node.enabled ? null : <Badge variant="outline">Disabled</Badge>}
          <Badge variant={node.allowShell ? "warning" : "outline"}>
            {node.allowShell ? "Shell allowed" : "No shell"}
          </Badge>
        </span>
      }
      description={
        <span className="break-all">
          {describeTransport(node)} ·{" "}
          {node.workspaceRoots.length === 0
            ? "No workspace root, so it runs nothing"
            : `Jobs run inside ${node.workspaceRoots.join(", ")}`}
        </span>
      }
      status={
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ObservationLabel
              observation={presentObservation({
                observedAt: node.availability.observedAt,
                nowMs,
                verb: "Probed",
                staleAfterMs: PROBE_STALE_AFTER_MS,
              })}
            />
            <span>A snapshot, not a promise about the next job.</span>
          </div>
          {platform || tools ? <span>{[platform, tools].filter(Boolean).join(" · ")}</span> : null}
          {node.availability.error ? (
            <span className="text-destructive">{node.availability.error}</span>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void runProbe()}
          >
            <ActivityIcon />
            {busy === "probe" ? "Probing…" : "Probe"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy !== null}
                  aria-label={`Actions for ${node.label}`}
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
              <MenuSeparator />
              <MenuItem onClick={() => void removeNode()}>
                <Trash2Icon />
                Remove
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    />
  );
}

function describeJobAction(job: Job): string {
  const action = job.action;
  const type: string = action.type;
  if (action.type === "command") return [action.executable, ...action.args].join(" ");
  if (action.type === "shell") return action.script.split("\n")[0] ?? "shell";
  return type;
}

function JobRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const nowMs = useRelativeTimeTick(60_000);
  const jobs = useEnvironmentQuery(
    automationEnvironment.jobs({ environmentId, input: { limit: JOB_PAGE_SIZE } }),
  );
  const nodes = useEnvironmentQuery(automationEnvironment.nodes({ environmentId, input: {} }));
  return (
    <>
      <SettingsRow
        title="Recent jobs"
        description="A job keeps running after whatever submitted it exits."
      />
      <QueryRows
        query={jobs}
        noun="jobs"
        isEmpty={(data) => data.jobs.length === 0}
        emptyDescription="No job has run in this environment yet."
      >
        {(data) => (
          <>
            {data.jobs.map((job) => (
              <JobRow
                key={job.id}
                environmentId={environmentId}
                job={job}
                nodeLabel={
                  nodes.data?.nodes.find((node) => node.id === job.nodeId)?.label ?? job.nodeId
                }
                nowMs={nowMs}
              />
            ))}
            {data.jobs.length >= JOB_PAGE_SIZE ? (
              <SettingsRow
                title="Partial list"
                description={`Showing ${JOB_PAGE_SIZE} jobs. Use t3 job list for the rest.`}
                role="status"
              />
            ) : null}
          </>
        )}
      </QueryRows>
    </>
  );
}

function JobRow({
  environmentId,
  job,
  nodeLabel,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly job: Job;
  readonly nodeLabel: string;
  readonly nowMs: number;
}) {
  const readLogs = useAtomCommand(automationEnvironment.readJobLogs, {
    label: "job logs",
    reportFailure: false,
  });
  const [log, setLog] = useState<{ text: string; complete: boolean; cut: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const status = presentJobStatus(job.status);
  const loadLog = async () => {
    if (loading) return;
    setLoading(true);
    const afterByte = Math.max(0, job.logBytes - LOG_TAIL_BYTES);
    const result = await readLogs({
      environmentId,
      input: { jobId: job.id, afterByte, maxBytes: LOG_TAIL_BYTES },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setLog({
        text: tailLogText(result.value.text, LOG_TAIL_LINES),
        complete: result.value.complete,
        cut: afterByte > 0 || job.logTruncated,
      });
      return;
    }
    reportAutomationFailure("Could not read the job log", result);
  };
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <code className="break-all">{describeJobAction(job)}</code>
          <AutomationStatusBadge status={status} />
        </span>
      }
      description={
        <span className="break-all">
          {nodeLabel} · {job.cwd}
          {job.statusReason ? ` · ${job.statusReason}` : ""}
        </span>
      }
      status={
        <span>
          {job.exitCode === null ? "No exit code seen" : `Exit code ${job.exitCode}`} · accepted{" "}
          {formatAutomationAge(Math.max(0, nowMs - Date.parse(job.acceptedAt)))}
          {job.finishedAt !== null
            ? ` · finished ${formatAutomationAge(Math.max(0, nowMs - Date.parse(job.finishedAt)))}`
            : ""}
          {job.logTruncated ? " · log was cut at the size limit" : ""}
        </span>
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={loading || job.logBytes === 0}
          onClick={() => void loadLog()}
        >
          <ScrollTextIcon />
          {job.logBytes === 0 ? "No output" : log === null ? "Show log tail" : "Refresh log"}
        </Button>
      }
    >
      {log !== null ? (
        <div className="space-y-1 px-3 pb-3 sm:px-4">
          <Textarea
            variant="code"
            readOnly
            aria-label={`Log tail of ${describeJobAction(job)}`}
            value={log.text.length > 0 ? log.text : "(no output in this range)"}
          />
          <p className="text-2xs text-muted-foreground">
            {log.cut ? "The end of the log only. " : ""}
            {log.complete ? "The job has ended and this is all of it." : "More output may follow."}
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function NodeEditorDialog({
  initialEnvironmentId,
  node,
  environments,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly node: ExecutionNode | null;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const nodes = useEnvironmentQuery(automationEnvironment.nodes({ environmentId, input: {} }));
  const upsert = useAtomCommand(automationEnvironment.upsertNode, {
    label: "node upsert",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ExecutionNodeDraft>(() =>
    node ? executionNodeToDraft(node) : emptyExecutionNodeDraft(),
  );
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const update = (patch: Partial<ExecutionNodeDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const submit = async () => {
    if (submissionPending.current || saving) return;
    const result = executionNodeDraftToInput(draft);
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
      const error = reportAutomationFailure("Could not save the node", outcome);
      if (error !== null) setErrors([error.message]);
      return;
    }
    nodes.refresh();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{node ? `Edit ${node.label}` : "Add node"}</DialogTitle>
          <DialogDescription>
            A machine this environment can run commands on. Jobs only run inside its workspace
            roots.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Belongs to" htmlFor="node-environment">
                <Select
                  value={environmentId}
                  disabled={node !== null || saving}
                  onValueChange={(id) => {
                    const next = environments.find((entry) => entry.environmentId === id);
                    if (next) setEnvironmentId(next.environmentId);
                  }}
                >
                  <SelectTrigger id="node-environment" size="sm">
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
              <Field label="Name" htmlFor="node-label">
                <Input
                  id="node-label"
                  placeholder="e.g. Build box"
                  value={draft.label}
                  onChange={(event) => update({ label: event.target.value })}
                />
              </Field>
            </div>
            <Field label="Connection" htmlFor="node-transport">
              <Select
                value={draft.transportType}
                onValueChange={(value) => update({ transportType: value ?? draft.transportType })}
              >
                <SelectTrigger id="node-transport" size="sm">
                  <SelectValue>
                    {draft.transportType === "local"
                      ? "This environment's machine"
                      : draft.transportType === "ssh"
                        ? "Another machine over SSH"
                        : draft.transportType}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="local">This environment's machine</SelectItem>
                  <SelectItem value="ssh">Another machine over SSH</SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.transportType === "ssh" ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="SSH target" htmlFor="node-ssh-target">
                  <Input
                    id="node-ssh-target"
                    placeholder="dev@build"
                    value={draft.sshTarget}
                    onChange={(event) => update({ sshTarget: event.target.value })}
                  />
                </Field>
                <Field label="Port" hint="Optional" htmlFor="node-ssh-port">
                  <Input
                    id="node-ssh-port"
                    inputMode="numeric"
                    placeholder="22"
                    value={draft.sshPort}
                    onChange={(event) => update({ sshPort: event.target.value })}
                  />
                </Field>
                <Field label="Identity file" hint="Optional" htmlFor="node-ssh-identity">
                  <Input
                    id="node-ssh-identity"
                    placeholder="~/.ssh/id_ed25519"
                    value={draft.sshIdentityFile}
                    onChange={(event) => update({ sshIdentityFile: event.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            {draft.transportType === "ssh" ? (
              <p className="text-xs text-muted-foreground">
                Key-based login must already work without a prompt.
              </p>
            ) : null}
            <Field
              label="Workspace roots"
              hint="One directory per line. Without one the node runs nothing."
              htmlFor="node-roots"
            >
              <Textarea
                id="node-roots"
                variant="code"
                spellCheck={false}
                value={draft.workspaceRoots}
                onChange={(event) => update({ workspaceRoots: event.target.value })}
              />
            </Field>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Enabled</p>
                <p className="text-sm text-muted-foreground">A disabled node accepts no jobs.</p>
              </div>
              <Switch
                aria-label="Enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Allow shell lines</p>
                <p className="text-sm text-muted-foreground">
                  Lets a job run an arbitrary shell line here. It also needs a credential with the
                  automation:execute scope.
                </p>
              </div>
              <Switch
                aria-label="Allow shell lines"
                checked={draft.allowShell}
                onCheckedChange={(allowShell) => update({ allowShell })}
              />
            </div>
            <DraftErrors errors={errors} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {node ? "Save node" : "Add node"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
