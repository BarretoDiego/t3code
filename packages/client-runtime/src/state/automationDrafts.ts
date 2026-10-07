import {
  type AutomationEventFilter,
  DEFAULT_HOOK_RETRY_POLICY,
  DEFAULT_RESPONSIBILITY_ORDER,
  type ExecutionNode,
  ExecutionNodeUpsertInput,
  type Hook,
  HookUpsertInput,
  IdempotencyKey,
  type ModelSelection,
  type Orchestrator,
  OrchestratorUpsertInput,
  type Peer,
  PeerAddInput,
  PeerPermissions,
  PeerUpdateInput,
} from "@t3tools/contracts";
import { formatSchemaError } from "@t3tools/shared/schemaJson";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/**
 * Editor drafts for orchestrators, hooks, peers and execution nodes.
 *
 * A draft holds what the form shows, as the strings the user typed. Turning it
 * into a command input validates it against the contract schema, so a form can
 * never send something the server would reject for its shape. Fields a form
 * does not show travel through the draft untouched, so editing a record made
 * by the CLI does not strip them.
 */

export type AutomationDraftResult<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/** `scope` names the action, `nonce` is a fresh UUID made once when the user starts it. */
export function makeAutomationIdempotencyKey(scope: string, nonce: string): IdempotencyKey {
  return IdempotencyKey.make(`${scope}:${nonce}`.slice(0, 200));
}

/** Splits on commas and new lines, trims, and drops blanks and repeats. */
export function parseAutomationTokenList(text: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const token of text.split(/[\n,]/)) {
    const trimmed = token.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function formatTokenList(tokens: ReadonlyArray<string> | undefined): string {
  return (tokens ?? []).join("\n");
}

function parseJsonRecord(
  text: string,
  label: string,
  errors: Array<string>,
): Record<string, unknown> | null {
  if (text.trim().length === 0) {
    errors.push(`${label} is empty.`);
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${label} must be a JSON object.`);
      return null;
    }
    return value as Record<string, unknown>;
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
    );
    return null;
  }
}

function parseWholeNumber(
  text: string,
  label: string,
  errors: Array<string>,
  options: { readonly min: number; readonly max?: number },
): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) {
    errors.push(`${label} must be a whole number.`);
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < options.min) {
    errors.push(`${label} must be at least ${options.min}.`);
    return null;
  }
  if (options.max !== undefined && value > options.max) {
    errors.push(`${label} must be at most ${options.max}.`);
    return null;
  }
  return value;
}

type Decoder<Input> = (candidate: unknown) => Exit.Exit<Input, Schema.SchemaError>;

const decodeOrchestratorUpsertInput = Schema.decodeUnknownExit(OrchestratorUpsertInput);
const decodeHookUpsertInput = Schema.decodeUnknownExit(HookUpsertInput);
const decodePeerPermissions = Schema.decodeUnknownExit(PeerPermissions);
const decodePeerAddInput = Schema.decodeUnknownExit(PeerAddInput);
const decodePeerUpdateInput = Schema.decodeUnknownExit(PeerUpdateInput);
const decodeExecutionNodeUpsertInput = Schema.decodeUnknownExit(ExecutionNodeUpsertInput);

function validateInput<Input>(
  decode: Decoder<Input>,
  candidate: unknown,
  errors: Array<string>,
): AutomationDraftResult<Input> {
  if (errors.length > 0) return { ok: false, errors };
  const exit = decode(candidate);
  if (Exit.isFailure(exit)) {
    return { ok: false, errors: [formatSchemaError(exit.cause)] };
  }
  return { ok: true, input: exit.value };
}

/** An edit names the revision it replaces, so a change made elsewhere is not overwritten. */
function revisionFields(
  draft: { readonly editingId: string | null; readonly expectedRevision: number | null },
  errors: Array<string>,
): { readonly id?: string; readonly expectedRevision?: number } {
  if (draft.editingId === null) return {};
  if (draft.expectedRevision === null) {
    errors.push("This record has no known revision. Reload it before saving.");
    return { id: draft.editingId };
  }
  return { id: draft.editingId, expectedRevision: draft.expectedRevision };
}

function splitModelKey(value: string): { instanceId: string; model: string } | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return { instanceId: value.slice(0, index), model: value.slice(index + 1) };
}

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Orchestrators
// ---------------------------------------------------------------------------

export interface OrchestratorDraft {
  readonly editingId: string | null;
  /** The revision the edit replaces. Null on a new orchestrator. */
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly scope: string;
  readonly projectId: string;
  /** `instanceId:model`, the key the model picker uses. */
  readonly modelKey: string;
  /** The saved selection, kept so provider options survive when the model is unchanged. */
  readonly baseModelSelection: ModelSelection | null;
  readonly profile: string;
  readonly runtimeMode: string;
  readonly instructions: string;
  readonly batchWindowSeconds: string;
  /** `{ permissions, budget, responsibilityOrder }` as JSON, validated on save. */
  readonly policyJson: string;
}

/** A new orchestrator may read and message threads and delegate; approvals stay with the user. */
export const DEFAULT_ORCHESTRATOR_POLICY = {
  permissions: {
    actions: [
      "thread.read",
      "thread.create",
      "thread.send",
      "request.answer",
      "task.delegate",
      "task.cancel",
    ],
  },
  budget: {
    maxTokens: 2_000_000,
    maxTurnsPerTask: 12,
    maxTurnsPerHour: 30,
    maxConcurrentChildren: 3,
    maxChildrenPerTask: 4,
    maxTaskAttempts: 2,
    maxTurnDurationMs: 900_000,
  },
  responsibilityOrder: DEFAULT_RESPONSIBILITY_ORDER,
} as const;

export function emptyOrchestratorDraft(defaults: {
  readonly projectId?: string;
  readonly modelSelection?: ModelSelection | null;
}): OrchestratorDraft {
  return {
    editingId: null,
    expectedRevision: null,
    name: "",
    scope: "local",
    projectId: defaults.projectId ?? "",
    modelKey: defaults.modelSelection ? modelKey(defaults.modelSelection) : "",
    baseModelSelection: defaults.modelSelection ?? null,
    profile: "",
    runtimeMode: "approval-required",
    instructions: "",
    batchWindowSeconds: "15",
    policyJson: prettyJson(DEFAULT_ORCHESTRATOR_POLICY),
  };
}

export function orchestratorToDraft(orchestrator: Orchestrator): OrchestratorDraft {
  return {
    editingId: orchestrator.id,
    expectedRevision: orchestrator.revision,
    name: orchestrator.name,
    scope: orchestrator.scope,
    projectId: orchestrator.projectId,
    modelKey: modelKey(orchestrator.modelSelection),
    baseModelSelection: orchestrator.modelSelection,
    profile: orchestrator.profile ?? "",
    runtimeMode: orchestrator.runtimeMode,
    instructions: orchestrator.instructions,
    batchWindowSeconds: String(orchestrator.batchWindowMs / 1_000),
    policyJson: prettyJson({
      permissions: orchestrator.permissions,
      budget: orchestrator.budget,
      responsibilityOrder: orchestrator.responsibilityOrder,
    }),
  };
}

export function orchestratorDraftToInput(
  draft: OrchestratorDraft,
  options: { readonly idempotencyKey: IdempotencyKey },
): AutomationDraftResult<OrchestratorUpsertInput> {
  const errors: Array<string> = [];
  if (draft.name.trim().length === 0) errors.push("Give the orchestrator a name.");
  if (draft.projectId.trim().length === 0) errors.push("Choose a project.");
  const selection = splitModelKey(draft.modelKey);
  if (selection === null) errors.push("Choose a model.");
  const batchSeconds = Number(draft.batchWindowSeconds.trim());
  if (
    draft.batchWindowSeconds.trim().length === 0 ||
    !Number.isFinite(batchSeconds) ||
    batchSeconds < 0
  ) {
    errors.push("Batch window must be zero or more seconds.");
  }
  const policy = parseJsonRecord(draft.policyJson, "Permissions and limits", errors);
  if (policy !== null) {
    for (const key of Object.keys(policy)) {
      if (key !== "permissions" && key !== "budget" && key !== "responsibilityOrder") {
        errors.push(
          `Permissions and limits has an unknown key "${key}". Use permissions, budget and responsibilityOrder.`,
        );
      }
    }
  }
  const base = draft.baseModelSelection;
  const modelSelection =
    selection === null
      ? null
      : base !== null && base.instanceId === selection.instanceId && base.model === selection.model
        ? base
        : selection;
  const profile = draft.profile.trim();
  return validateInput(
    decodeOrchestratorUpsertInput,
    {
      ...revisionFields(draft, errors),
      idempotencyKey: options.idempotencyKey,
      name: draft.name.trim(),
      scope: draft.scope,
      projectId: draft.projectId.trim(),
      modelSelection,
      ...(profile.length === 0 ? {} : { profile }),
      runtimeMode: draft.runtimeMode,
      instructions: draft.instructions,
      permissions: policy?.permissions,
      budget: policy?.budget,
      responsibilityOrder: policy?.responsibilityOrder,
      batchWindowMs: Math.round(batchSeconds * 1_000),
    },
    errors,
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookDraft {
  readonly editingId: string | null;
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly enabled: boolean;
  /** Event types, one per line: an exact type or a prefix ending in `.*`. */
  readonly eventTypes: string;
  readonly projectIds: string;
  readonly threadIds: string;
  readonly orchestratorIds: string;
  /** The saved filter. Keys the form does not show are sent back unchanged. */
  readonly baseFilter: AutomationEventFilter | null;
  readonly targetType: string;
  readonly orchestratorId: string;
  readonly consumerId: string;
  readonly webhookUrl: string;
  readonly webhookSecretRef: string;
  readonly commandExecutable: string;
  /** One argument per line. Nothing is split or quoted. */
  readonly commandArgs: string;
  /**
   * The saved arguments. Text cannot hold an empty last argument or one with a
   * line break, so untouched text sends these back exactly.
   */
  readonly baseCommandArgs: ReadonlyArray<string> | null;
  readonly commandCwd: string;
  readonly commandEnvAllowlist: string;
  readonly deliveryMode: string;
  readonly batchWindowSeconds: string;
  /** `{ retry, timeoutMs, priority, cooldownMs?, maxDeliveriesPerTask? }` as JSON. */
  readonly policyJson: string;
}

export const DEFAULT_HOOK_POLICY = {
  retry: DEFAULT_HOOK_RETRY_POLICY,
  timeoutMs: 10_000,
  priority: 0,
} as const;

const EMPTY_HOOK_TARGET_FIELDS = {
  orchestratorId: "",
  consumerId: "",
  webhookUrl: "",
  webhookSecretRef: "",
  commandExecutable: "",
  commandArgs: "",
  baseCommandArgs: null,
  commandCwd: "",
  commandEnvAllowlist: "",
} as const;

export function emptyHookDraft(defaults: { readonly orchestratorId?: string }): HookDraft {
  return {
    editingId: null,
    expectedRevision: null,
    name: "",
    enabled: true,
    eventTypes: "task.reported\ntask.failed\ntask.unknown",
    projectIds: "",
    threadIds: "",
    orchestratorIds: "",
    baseFilter: null,
    targetType: "orchestrator_inbox",
    ...EMPTY_HOOK_TARGET_FIELDS,
    orchestratorId: defaults.orchestratorId ?? "",
    deliveryMode: "batch",
    batchWindowSeconds: "3",
    policyJson: prettyJson(DEFAULT_HOOK_POLICY),
  };
}

export function hookToDraft(hook: Hook): HookDraft {
  const target = hook.target;
  return {
    editingId: hook.id,
    expectedRevision: hook.revision,
    name: hook.name,
    enabled: hook.enabled,
    eventTypes: formatTokenList(hook.filter.types),
    projectIds: formatTokenList(hook.filter.projectIds),
    threadIds: formatTokenList(hook.filter.threadIds),
    orchestratorIds: formatTokenList(hook.filter.orchestratorIds),
    baseFilter: hook.filter,
    targetType: target.type,
    ...EMPTY_HOOK_TARGET_FIELDS,
    ...(target.type === "orchestrator_inbox" ? { orchestratorId: target.orchestratorId } : {}),
    ...(target.type === "cli_consumer" ? { consumerId: target.consumerId } : {}),
    ...(target.type === "webhook"
      ? { webhookUrl: target.url, webhookSecretRef: target.secretRef }
      : {}),
    ...(target.type === "command"
      ? {
          commandExecutable: target.executable,
          commandArgs: target.args.join("\n"),
          baseCommandArgs: target.args,
          commandCwd: target.cwd ?? "",
          commandEnvAllowlist: formatTokenList(target.envAllowlist),
        }
      : {}),
    deliveryMode: hook.deliveryMode,
    batchWindowSeconds: hook.batchWindowMs === undefined ? "3" : String(hook.batchWindowMs / 1_000),
    policyJson: prettyJson({
      retry: hook.retry,
      timeoutMs: hook.timeoutMs,
      priority: hook.priority,
      ...(hook.cooldownMs === undefined ? {} : { cooldownMs: hook.cooldownMs }),
      ...(hook.maxDeliveriesPerTask === undefined
        ? {}
        : { maxDeliveriesPerTask: hook.maxDeliveriesPerTask }),
    }),
  };
}

const HOOK_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*(\.\*)?$/;
const HOOK_POLICY_KEYS = new Set([
  "retry",
  "timeoutMs",
  "priority",
  "cooldownMs",
  "maxDeliveriesPerTask",
]);

/** True for an exact event type such as `task.reported` or a prefix such as `task.*`. */
export function isHookEventTypePattern(token: string): boolean {
  return HOOK_EVENT_TYPE_PATTERN.test(token);
}

function hookFilterFromDraft(draft: HookDraft, errors: Array<string>): Record<string, unknown> {
  const types = parseAutomationTokenList(draft.eventTypes);
  for (const type of types) {
    if (!isHookEventTypePattern(type)) {
      errors.push(`"${type}" is not an event type. Use a type such as task.reported, or task.*.`);
    }
  }
  const shown = {
    types,
    projectIds: parseAutomationTokenList(draft.projectIds),
    threadIds: parseAutomationTokenList(draft.threadIds),
    orchestratorIds: parseAutomationTokenList(draft.orchestratorIds),
  };
  const filter: Record<string, unknown> = { ...draft.baseFilter };
  for (const key of Object.keys(shown) as Array<keyof typeof shown>) {
    // An emptied field removes the key: absent and empty both mean "any".
    if (shown[key].length === 0) delete filter[key];
    else filter[key] = shown[key];
  }
  return filter;
}

function hookTargetFromDraft(draft: HookDraft, errors: Array<string>): Record<string, unknown> {
  switch (draft.targetType) {
    case "orchestrator_inbox":
      if (draft.orchestratorId.trim().length === 0) errors.push("Choose an orchestrator.");
      return { type: "orchestrator_inbox", orchestratorId: draft.orchestratorId.trim() };
    case "cli_consumer":
      if (draft.consumerId.trim().length === 0) errors.push("Name the CLI consumer.");
      return { type: "cli_consumer", consumerId: draft.consumerId.trim() };
    case "webhook": {
      const url = draft.webhookUrl.trim();
      if (!/^https?:\/\/\S+$/i.test(url))
        errors.push("The webhook URL must start with http:// or https://.");
      if (draft.webhookSecretRef.trim().length === 0) {
        errors.push("Name the server secret that signs the webhook body.");
      }
      return { type: "webhook", url, secretRef: draft.webhookSecretRef.trim() };
    }
    case "command": {
      if (draft.commandExecutable.trim().length === 0) {
        errors.push("Enter the absolute path of the executable.");
      }
      const cwd = draft.commandCwd.trim();
      const envAllowlist = parseAutomationTokenList(draft.commandEnvAllowlist);
      return {
        type: "command",
        executable: draft.commandExecutable.trim(),
        args:
          draft.baseCommandArgs !== null && draft.baseCommandArgs.join("\n") === draft.commandArgs
            ? draft.baseCommandArgs
            : draft.commandArgs.length === 0
              ? []
              : draft.commandArgs.replace(/\n$/, "").split("\n"),
        ...(cwd.length === 0 ? {} : { cwd }),
        ...(envAllowlist.length === 0 ? {} : { envAllowlist }),
      };
    }
    default:
      errors.push(`"${draft.targetType}" is not a destination this app can edit.`);
      return { type: draft.targetType };
  }
}

export function hookDraftToInput(
  draft: HookDraft,
  options: { readonly idempotencyKey: IdempotencyKey },
): AutomationDraftResult<HookUpsertInput> {
  const errors: Array<string> = [];
  if (draft.name.trim().length === 0) errors.push("Give the hook a name.");
  const filter = hookFilterFromDraft(draft, errors);
  const target = hookTargetFromDraft(draft, errors);
  const policy = parseJsonRecord(draft.policyJson, "Delivery policy", errors);
  if (policy !== null) {
    for (const key of Object.keys(policy)) {
      if (!HOOK_POLICY_KEYS.has(key)) {
        errors.push(`Delivery policy has an unknown key "${key}".`);
      }
    }
  }
  let batchWindowMs: number | undefined;
  if (draft.deliveryMode === "batch") {
    const seconds = Number(draft.batchWindowSeconds.trim());
    if (draft.batchWindowSeconds.trim().length === 0 || !Number.isFinite(seconds) || seconds <= 0) {
      errors.push("Batch window must be more than zero seconds.");
    } else {
      batchWindowMs = Math.max(1, Math.round(seconds * 1_000));
    }
  }
  return validateInput(
    decodeHookUpsertInput,
    {
      ...(draft.editingId === null ? { startAt: "head" } : {}),
      ...revisionFields(draft, errors),
      idempotencyKey: options.idempotencyKey,
      name: draft.name.trim(),
      enabled: draft.enabled,
      filter,
      target,
      deliveryMode: draft.deliveryMode,
      ...(batchWindowMs === undefined ? {} : { batchWindowMs }),
      ...policy,
    },
    errors,
  );
}

/** "task.reported, task.failed · 1 project", or "Every event" for an empty filter. */
export function summarizeHookFilter(filter: AutomationEventFilter): string {
  const parts: Array<string> = [];
  const types = filter.types ?? [];
  parts.push(
    types.length === 0
      ? "Every event"
      : types.length <= 3
        ? types.join(", ")
        : `${types.slice(0, 3).join(", ")} +${types.length - 3}`,
  );
  const narrowed: ReadonlyArray<readonly [ReadonlyArray<unknown> | undefined, string, string]> = [
    [filter.projectIds, "project", "projects"],
    [filter.threadIds, "thread", "threads"],
    [filter.parentThreadIds, "parent thread", "parent threads"],
    [filter.rootThreadIds, "thread tree", "thread trees"],
    [filter.orchestratorIds, "orchestrator", "orchestrators"],
    [filter.taskIds, "task", "tasks"],
    [filter.nodeIds, "node", "nodes"],
    [filter.originEnvironmentIds, "origin environment", "origin environments"],
  ];
  for (const [values, singular, plural] of narrowed) {
    if (values !== undefined && values.length > 0) {
      parts.push(`${values.length} ${values.length === 1 ? singular : plural}`);
    }
  }
  return parts.join(" · ");
}

export interface HookTargetSummary {
  readonly label: string;
  /** Webhook and command destinations work only when the server operator allowed them. */
  readonly needsOperatorAllowlist: boolean;
}

export function summarizeHookTarget(
  target: Hook["target"],
  orchestratorName: (orchestratorId: string) => string | null,
): HookTargetSummary {
  // Read through a string so a destination from a newer server still gets a label.
  const type: string = target.type;
  switch (target.type) {
    case "orchestrator_inbox":
      return {
        label: `Inbox of ${orchestratorName(target.orchestratorId) ?? target.orchestratorId}`,
        needsOperatorAllowlist: false,
      };
    case "cli_consumer":
      return { label: `CLI consumer ${target.consumerId}`, needsOperatorAllowlist: false };
    case "webhook":
      return { label: `Webhook ${target.url}`, needsOperatorAllowlist: true };
    case "command":
      return { label: `Command ${target.executable}`, needsOperatorAllowlist: true };
    default:
      return { label: type, needsOperatorAllowlist: false };
  }
}

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

/** A new peer may ask for nothing until it is given permissions. */
export const DEFAULT_PEER_PERMISSIONS = { inbound: [], forwardEventTypes: [] } as const;

export interface PeerAddDraft {
  readonly name: string;
  /** `link`: a pairing link from the peer. `token`: its URL and a token. */
  readonly mode: "link" | "token";
  readonly pairingUrl: string;
  readonly httpBaseUrl: string;
  readonly token: string;
  readonly permissionsJson: string;
}

export function emptyPeerAddDraft(): PeerAddDraft {
  return {
    name: "",
    mode: "link",
    pairingUrl: "",
    httpBaseUrl: "",
    token: "",
    permissionsJson: prettyJson(DEFAULT_PEER_PERMISSIONS),
  };
}

function parsePeerPermissions(text: string, errors: Array<string>): unknown {
  const permissions = parseJsonRecord(text, "Permissions", errors);
  if (permissions === null) return undefined;
  const exit = decodePeerPermissions(permissions);
  if (Exit.isFailure(exit)) {
    errors.push(`Permissions: ${formatSchemaError(exit.cause)}`);
    return undefined;
  }
  return exit.value;
}

export function peerAddDraftToInput(draft: PeerAddDraft): AutomationDraftResult<PeerAddInput> {
  const errors: Array<string> = [];
  if (draft.name.trim().length === 0) errors.push("Give the peer a name.");
  if (draft.mode === "link") {
    if (draft.pairingUrl.trim().length === 0) errors.push("Paste the link the peer printed.");
  } else {
    if (!/^https?:\/\/\S+$/i.test(draft.httpBaseUrl.trim())) {
      errors.push("The peer URL must start with http:// or https://.");
    }
    if (draft.token.trim().length === 0) errors.push("Enter the token the peer printed.");
  }
  const permissions = parsePeerPermissions(draft.permissionsJson, errors);
  return validateInput(
    decodePeerAddInput,
    {
      name: draft.name.trim(),
      ...(draft.mode === "link"
        ? { pairingUrl: draft.pairingUrl.trim() }
        : { httpBaseUrl: draft.httpBaseUrl.trim(), token: draft.token.trim() }),
      permissions,
    },
    errors,
  );
}

export interface PeerEditDraft {
  readonly environmentId: string;
  readonly name: string;
  readonly httpBaseUrl: string;
  readonly permissionsJson: string;
}

export function peerToEditDraft(peer: Peer): PeerEditDraft {
  return {
    environmentId: peer.environmentId,
    name: peer.name,
    httpBaseUrl: peer.httpBaseUrl,
    permissionsJson: prettyJson(peer.permissions),
  };
}

/**
 * Sends only what changed. A peer has no revision, so naming every field would
 * overwrite a change made elsewhere to a field this edit never touched.
 * `changed` is false when the draft equals the peer.
 */
export function peerEditDraftToInput(
  draft: PeerEditDraft,
  peer: Peer,
): AutomationDraftResult<PeerUpdateInput> & { readonly changed?: boolean } {
  const errors: Array<string> = [];
  if (draft.name.trim().length === 0) errors.push("Give the peer a name.");
  if (!/^https?:\/\/\S+$/i.test(draft.httpBaseUrl.trim())) {
    errors.push("The peer URL must start with http:// or https://.");
  }
  const permissions = parsePeerPermissions(draft.permissionsJson, errors);
  const nameChanged = draft.name.trim() !== peer.name;
  const urlChanged = draft.httpBaseUrl.trim() !== peer.httpBaseUrl;
  const permissionsChanged =
    permissions !== undefined && JSON.stringify(permissions) !== JSON.stringify(peer.permissions);
  const result = validateInput(
    decodePeerUpdateInput,
    {
      environmentId: draft.environmentId,
      ...(nameChanged ? { name: draft.name.trim() } : {}),
      ...(urlChanged ? { httpBaseUrl: draft.httpBaseUrl.trim() } : {}),
      ...(permissionsChanged ? { permissions } : {}),
    },
    errors,
  );
  return result.ok
    ? { ...result, changed: nameChanged || urlChanged || permissionsChanged }
    : result;
}

// ---------------------------------------------------------------------------
// Execution nodes
// ---------------------------------------------------------------------------

export interface ExecutionNodeDraft {
  readonly editingId: string | null;
  readonly label: string;
  readonly transportType: string;
  readonly sshTarget: string;
  readonly sshPort: string;
  readonly sshIdentityFile: string;
  readonly enabled: boolean;
  /** One directory per line. Jobs may only run inside them. */
  readonly workspaceRoots: string;
  readonly allowShell: boolean;
}

export function emptyExecutionNodeDraft(): ExecutionNodeDraft {
  return {
    editingId: null,
    label: "",
    transportType: "ssh",
    sshTarget: "",
    sshPort: "",
    sshIdentityFile: "",
    enabled: true,
    workspaceRoots: "",
    allowShell: false,
  };
}

export function executionNodeToDraft(node: ExecutionNode): ExecutionNodeDraft {
  const transport = node.transport;
  return {
    editingId: node.id,
    label: node.label,
    transportType: transport.type,
    sshTarget: transport.type === "ssh" ? transport.target : "",
    sshPort: transport.type === "ssh" && transport.port !== undefined ? String(transport.port) : "",
    sshIdentityFile: transport.type === "ssh" ? (transport.identityFile ?? "") : "",
    enabled: node.enabled,
    workspaceRoots: node.workspaceRoots.join("\n"),
    allowShell: node.allowShell,
  };
}

export function executionNodeDraftToInput(
  draft: ExecutionNodeDraft,
): AutomationDraftResult<ExecutionNodeUpsertInput> {
  const errors: Array<string> = [];
  if (draft.label.trim().length === 0) errors.push("Give the node a name.");
  let transport: Record<string, unknown>;
  if (draft.transportType === "local") {
    transport = { type: "local" };
  } else if (draft.transportType === "ssh") {
    if (draft.sshTarget.trim().length === 0)
      errors.push("Enter the SSH target, such as dev@build.");
    const port =
      draft.sshPort.trim().length === 0
        ? null
        : parseWholeNumber(draft.sshPort, "SSH port", errors, { min: 1, max: 65_535 });
    const identityFile = draft.sshIdentityFile.trim();
    transport = {
      type: "ssh",
      target: draft.sshTarget.trim(),
      ...(port === null ? {} : { port }),
      ...(identityFile.length === 0 ? {} : { identityFile }),
    };
  } else {
    errors.push(`"${draft.transportType}" is not a connection this app can edit.`);
    transport = { type: draft.transportType };
  }
  // Split on lines only: a directory name may contain a comma.
  const workspaceRoots = [
    ...new Set(
      draft.workspaceRoots
        .split("\n")
        .map((root) => root.trim())
        .filter((root) => root.length > 0),
    ),
  ];
  return validateInput(
    decodeExecutionNodeUpsertInput,
    {
      ...(draft.editingId === null ? {} : { id: draft.editingId }),
      label: draft.label.trim(),
      transport,
      enabled: draft.enabled,
      workspaceRoots,
      allowShell: draft.allowShell,
    },
    errors,
  );
}
