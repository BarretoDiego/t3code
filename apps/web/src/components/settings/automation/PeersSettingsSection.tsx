import {
  emptyPeerAddDraft,
  peerAddDraftToInput,
  peerEditDraftToInput,
  peerToEditDraft,
  type PeerAddDraft,
  type PeerEditDraft,
} from "@t3tools/client-runtime/state/automation-drafts";
import {
  presentObservation,
  presentPeerConnectionStatus,
} from "@t3tools/client-runtime/state/automation-presentation";
import type { EnvironmentId, Peer } from "@t3tools/contracts";
import {
  CheckIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
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
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  automationEnvironmentAvailability,
  AUTOMATION_SETTINGS_ANCHORS,
} from "../automationSettings.logic";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settingsLayout";
import {
  AutomationEnvironmentSection,
  DraftErrors,
  Field,
  JsonField,
  QueryRows,
} from "./automationSettingsShared";

type PeerEditor =
  | { readonly kind: "add"; readonly environmentId: EnvironmentId }
  | { readonly kind: "edit"; readonly environmentId: EnvironmentId; readonly peer: Peer };

export function PeersSettingsSection({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [editor, setEditor] = useState<PeerEditor | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, peer: Peer) => {
    setEditor({ kind: "edit", environmentId, peer });
  }, []);
  const creatable = environments.filter(
    (environment) => automationEnvironmentAvailability(environment) === "ready",
  );
  const defaultEnvironment = creatable[0];
  return (
    <>
      <SettingsSection
        id={AUTOMATION_SETTINGS_ANCHORS.peers}
        title="Peers"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ kind: "add", environmentId: defaultEnvironment.environmentId })
            }
          >
            <PlusIcon className="size-3" />
            Add peer
          </Button>
        }
      >
        <div className="space-y-8">
          {environments.map((environment) => (
            <AutomationEnvironmentSection
              key={environment.environmentId}
              environment={environment}
              showHeading={environments.length > 1}
              noun="peers"
            >
              <EnvironmentIdentityRow environment={environment} />
              <PeerRows environmentId={environment.environmentId} onEdit={openForEdit} />
            </AutomationEnvironmentSection>
          ))}
        </div>
      </SettingsSection>
      {editor?.kind === "add" ? (
        <PeerAddDialog
          key={`add:${editor.environmentId}`}
          initialEnvironmentId={editor.environmentId}
          environments={creatable}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === "edit" ? (
        <PeerEditDialog
          key={`edit:${editor.environmentId}:${editor.peer.environmentId}`}
          environmentId={editor.environmentId}
          peer={editor.peer}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

/** The id the other side needs to mint a credential for this environment. */
function EnvironmentIdentityRow({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const identity = environment.serverConfig?.environment.environmentId ?? environment.environmentId;
  return (
    <SettingsRow
      title="This environment's ID"
      description="Give it to the other environment. It mints a credential for this ID, and you add that environment here with the link it prints."
      status={<code className="break-all">{identity}</code>}
      control={
        <Button
          size="sm"
          variant="outline"
          aria-label={`Copy the ID of ${environment.label}`}
          onClick={() => copyToClipboard(identity, undefined)}
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy ID"}
        </Button>
      }
    />
  );
}

function PeerRows({
  environmentId,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly onEdit: (environmentId: EnvironmentId, peer: Peer) => void;
}) {
  const nowMs = useRelativeTimeTick(60_000);
  const query = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  return (
    <QueryRows
      query={query}
      noun="peers"
      isEmpty={(data) => data.peers.length === 0}
      emptyDescription="A peer is another environment this one talks to directly."
    >
      {(data) =>
        data.peers.map((peer) => (
          <PeerRow
            key={peer.environmentId}
            environmentId={environmentId}
            peer={peer}
            nowMs={nowMs}
            onEdit={() => onEdit(environmentId, peer)}
            onChanged={query.refresh}
          />
        ))
      }
    </QueryRows>
  );
}

function PeerRow({
  environmentId,
  peer,
  nowMs,
  onEdit,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly peer: Peer;
  readonly nowMs: number;
  readonly onEdit: () => void;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const updatePeer = useAtomCommand(automationEnvironment.updatePeer, {
    label: "peer update",
    reportFailure: false,
  });
  const removePeer = useAtomCommand(automationEnvironment.removePeer, {
    label: "peer remove",
    reportFailure: false,
  });
  const status = presentPeerConnectionStatus(peer.status);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const result = await updatePeer({
      environmentId,
      input: { environmentId: peer.environmentId, enabled: !peer.enabled },
    });
    setBusy(false);
    if (reportAutomationFailure("Could not update the peer", result) === null) onChanged();
  };
  const remove = async () => {
    if (busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove peer "${peer.name}"? Its credential is deleted and the ${peer.outboxPending} message(s) waiting for it are cancelled.`,
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await removePeer({
      environmentId,
      input: { environmentId: peer.environmentId },
    });
    setBusy(false);
    if (reportAutomationFailure("Could not remove the peer", result) === null) onChanged();
  };
  return (
    <SettingsRow
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{peer.name}</span>
          <AutomationStatusBadge status={status} />
          {peer.enabled ? null : <Badge variant="outline">Disabled</Badge>}
        </span>
      }
      description={
        <span className="break-all">
          {peer.httpBaseUrl}
          {peer.statusReason ? ` · ${peer.statusReason}` : ""}
        </span>
      }
      status={
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ObservationLabel
              observation={presentObservation({
                observedAt: peer.lastObservedAt,
                nowMs,
                reachable: peer.status === "connected",
                verb: "Seen",
              })}
            />
            <span>
              {peer.outboxPending} waiting to send
              {peer.lastConnectedAt === null ? " · never connected" : ""}
            </span>
          </div>
          <span>
            May ask for:{" "}
            {peer.permissions.inbound.length === 0
              ? "nothing"
              : peer.permissions.inbound.join(", ")}
            {" · "}Receives:{" "}
            {peer.permissions.forwardEventTypes.length === 0
              ? "no events"
              : peer.permissions.forwardEventTypes.join(", ")}
            {peer.permissions.projectIds !== undefined
              ? ` · ${peer.permissions.projectIds.length} project(s)`
              : ""}
            {peer.permissions.nodeIds !== undefined
              ? ` · ${peer.permissions.nodeIds.length} node(s)`
              : ""}
          </span>
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={peer.enabled}
            disabled={busy}
            aria-label={`Enable ${peer.name}`}
            onCheckedChange={() => void toggle()}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${peer.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit name, URL and permissions
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => void remove()}>
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

const PERMISSIONS_HINT = "JSON: inbound, forwardEventTypes, projectIds, nodeIds";

function PeerAddDialog({
  initialEnvironmentId,
  environments,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onClose: () => void;
}) {
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const peers = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  const addPeer = useAtomCommand(automationEnvironment.addPeer, {
    label: "peer add",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<PeerAddDraft>(emptyPeerAddDraft);
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const update = (patch: Partial<PeerAddDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const submit = async () => {
    if (submissionPending.current || saving) return;
    const result = peerAddDraftToInput(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    setErrors([]);
    const outcome = await addPeer({ environmentId, input: result.input });
    setSaving(false);
    if (outcome._tag === "Failure") {
      submissionPending.current = false;
      const error = reportAutomationFailure("Could not add the peer", outcome);
      if (error !== null) setErrors([error.message]);
      return;
    }
    peers.refresh();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add peer</DialogTitle>
          <DialogDescription>
            Lets this environment call another one. The other side adds this environment separately
            if it should call back.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Add to" htmlFor="peer-environment">
                <Select
                  value={environmentId}
                  onValueChange={(id) => {
                    const next = environments.find((entry) => entry.environmentId === id);
                    if (next) setEnvironmentId(next.environmentId);
                  }}
                >
                  <SelectTrigger id="peer-environment" size="sm">
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
              <Field label="Name" htmlFor="peer-name">
                <Input
                  id="peer-name"
                  placeholder="e.g. Build box"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
            </div>
            <ToggleGroup
              aria-label="How to connect"
              value={[draft.mode]}
              onValueChange={(values) => {
                const mode = values[0];
                if (mode === "link" || mode === "token") update({ mode });
              }}
            >
              <Toggle value="link">Pairing link</Toggle>
              <Toggle value="token">URL and token</Toggle>
            </ToggleGroup>
            {draft.mode === "link" ? (
              <Field
                label="Link from the peer"
                hint="Printed by t3 peer credential create"
                htmlFor="peer-pairing-url"
              >
                <Input
                  id="peer-pairing-url"
                  value={draft.pairingUrl}
                  onChange={(event) => update({ pairingUrl: event.target.value })}
                />
              </Field>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Peer URL" htmlFor="peer-url">
                  <Input
                    id="peer-url"
                    placeholder="https://build.example"
                    value={draft.httpBaseUrl}
                    onChange={(event) => update({ httpBaseUrl: event.target.value })}
                  />
                </Field>
                <Field label="Token" htmlFor="peer-token">
                  <Input
                    id="peer-token"
                    type="password"
                    autoComplete="off"
                    value={draft.token}
                    onChange={(event) => update({ token: event.target.value })}
                  />
                </Field>
              </div>
            )}
            <JsonField
              id="peer-permissions"
              label="What the peer may ask"
              hint={PERMISSIONS_HINT}
              value={draft.permissionsJson}
              onChange={(permissionsJson) => update({ permissionsJson })}
            />
            <p className="text-xs text-muted-foreground">
              A new peer may ask for nothing. <code>inbound</code> accepts message.send,
              event.forward, task.delegate, task.read, orchestrator.read, orchestrator.send and
              orchestrator.host.
            </p>
            <DraftErrors errors={errors} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            Add peer
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PeerEditDialog({
  environmentId,
  peer,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly peer: Peer;
  readonly onClose: () => void;
}) {
  const peers = useEnvironmentQuery(automationEnvironment.peers({ environmentId, input: {} }));
  const updatePeer = useAtomCommand(automationEnvironment.updatePeer, {
    label: "peer update",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<PeerEditDraft>(() => peerToEditDraft(peer));
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<PeerEditDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const submit = async () => {
    if (saving) return;
    const result = peerEditDraftToInput(draft, peer);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    if (result.changed === false) {
      onClose();
      return;
    }
    setSaving(true);
    setErrors([]);
    const outcome = await updatePeer({ environmentId, input: result.input });
    setSaving(false);
    if (outcome._tag === "Failure") {
      const error = reportAutomationFailure("Could not update the peer", outcome);
      if (error !== null) setErrors([error.message]);
      return;
    }
    peers.refresh();
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {peer.name}</DialogTitle>
          <DialogDescription>
            A permission change also applies to messages that are already waiting.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="peer-edit-name">
                <Input
                  id="peer-edit-name"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                />
              </Field>
              <Field label="Peer URL" htmlFor="peer-edit-url">
                <Input
                  id="peer-edit-url"
                  value={draft.httpBaseUrl}
                  onChange={(event) => update({ httpBaseUrl: event.target.value })}
                />
              </Field>
            </div>
            <JsonField
              id="peer-edit-permissions"
              label="What the peer may ask"
              hint={PERMISSIONS_HINT}
              value={draft.permissionsJson}
              onChange={(permissionsJson) => update({ permissionsJson })}
            />
            <DraftErrors errors={errors} />
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            Save peer
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
