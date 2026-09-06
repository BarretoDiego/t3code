import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import {
  AGENT_PROFILE_SLUG_PATTERN,
  DEFAULT_AGENT_PROFILE_WRAPPER,
  isValidAgentProfileTemplate,
  slugifyAgentProfileName,
  type AgentProfile,
  type MiniSkill,
  type MiniSkillId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

export interface AgentProfileRouteDraft {
  /** Local row identity for editing; persisted as the route id. */
  readonly id: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly modelCandidates: string[];
  /** Empty string = inherit the profile's base effort. */
  readonly reasoningEffort: string;
}

export interface AgentProfileDraft {
  name: string;
  slug: string;
  /** True once the user edits the slug manually; auto-derivation stops. */
  slugTouched: boolean;
  description: string;
  enabled: boolean;
  /** Empty string = inherit the composer's current effort. */
  reasoningEffort: string;
  miniSkillIds: MiniSkillId[];
  instructions: string;
  useCustomTemplate: boolean;
  promptTemplate: string;
  routes: AgentProfileRouteDraft[];
}

export function emptyAgentProfileDraft(): AgentProfileDraft {
  return {
    name: "",
    slug: "",
    slugTouched: false,
    description: "",
    enabled: true,
    reasoningEffort: "",
    miniSkillIds: [],
    instructions: "",
    useCustomTemplate: false,
    promptTemplate: DEFAULT_AGENT_PROFILE_WRAPPER,
    routes: [],
  };
}

export function profileDraftFromProfile(profile: AgentProfile): AgentProfileDraft {
  return {
    name: profile.name,
    slug: profile.slug,
    slugTouched: true,
    description: profile.description,
    enabled: profile.enabled,
    reasoningEffort: profile.reasoningEffort ?? "",
    miniSkillIds: [...profile.miniSkillIds],
    instructions: profile.instructions,
    useCustomTemplate: profile.promptTemplate !== undefined,
    promptTemplate: profile.promptTemplate ?? DEFAULT_AGENT_PROFILE_WRAPPER,
    routes: profile.routes.map((route) => ({
      id: route.id,
      instanceId: route.instanceId,
      modelCandidates: [...route.modelCandidates],
      reasoningEffort: route.reasoningEffort ?? "",
    })),
  };
}

const SLUG_TEST = new RegExp(AGENT_PROFILE_SLUG_PATTERN);

export interface AgentProfileDraftIssue {
  readonly message: string;
}

export function validateAgentProfileDraft(
  draft: AgentProfileDraft,
  existingProfiles: ReadonlyArray<AgentProfile>,
  existingId: AgentProfile["id"] | null,
  miniSkills: ReadonlyArray<MiniSkill>,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): AgentProfileDraftIssue[] {
  const issues: AgentProfileDraftIssue[] = [];
  if (draft.name.trim().length === 0) {
    issues.push({ message: "Name is required." });
  }
  const slug = draft.slug.trim();
  if (!SLUG_TEST.test(slug)) {
    issues.push({
      message:
        "Shortcut must start with a letter and use only lowercase letters, numbers, and hyphens.",
    });
  } else if (
    existingProfiles.some((profile) => profile.slug === slug && profile.id !== existingId)
  ) {
    issues.push({ message: `Another profile already uses #${slug}.` });
  }
  if (draft.useCustomTemplate && !isValidAgentProfileTemplate(draft.promptTemplate)) {
    issues.push({ message: "The custom template must contain {{user_message}}." });
  }
  const knownSkillIds = new Set<string>(miniSkills.map((skill) => skill.id));
  const unknownSkills = draft.miniSkillIds.filter((id) => !knownSkillIds.has(id));
  if (unknownSkills.length > 0) {
    issues.push({ message: `${unknownSkills.length} selected Mini Skill(s) no longer exist.` });
  }
  const seenInstances = new Set<string>();
  for (const route of draft.routes) {
    if (route.instanceId === null) {
      issues.push({ message: "A provider configuration is missing its provider." });
      continue;
    }
    if (seenInstances.has(route.instanceId)) {
      issues.push({ message: "Each provider can only have one configuration." });
      break;
    }
    seenInstances.add(route.instanceId);
    const instance = instanceEntries.find((entry) => entry.instanceId === route.instanceId);
    if (!instance) {
      issues.push({
        message: "A provider configuration references a provider that no longer exists.",
      });
      continue;
    }
    if (new Set(route.modelCandidates).size !== route.modelCandidates.length) {
      issues.push({ message: `Duplicate fallback models in ${instance.displayName}.` });
    }
  }
  return issues;
}

export function AgentProfileEditorDialog(props: {
  readonly existing: AgentProfile | null;
  readonly initialDraft: AgentProfileDraft;
  readonly existingProfiles: ReadonlyArray<AgentProfile>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly miniSkills: ReadonlyArray<MiniSkill>;
  readonly onClose: () => void;
  readonly onSave: (draft: AgentProfileDraft, existing: AgentProfile | null) => void;
}) {
  const [draft, setDraft] = useState<AgentProfileDraft>(props.initialDraft);
  const issues = validateAgentProfileDraft(
    draft,
    props.existingProfiles,
    props.existing?.id ?? null,
    props.miniSkills,
    props.instanceEntries,
  );

  const update = (patch: Partial<AgentProfileDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateRoute = (routeId: string, patch: Partial<AgentProfileRouteDraft>) =>
    setDraft((current) => ({
      ...current,
      routes: current.routes.map((route) =>
        route.id === routeId ? { ...route, ...patch } : route,
      ),
    }));

  const routedInstanceIds = new Set(
    draft.routes.flatMap((route) => (route.instanceId !== null ? [route.instanceId] : [])),
  );
  const availableInstances = props.instanceEntries.filter(
    (entry) => entry.enabled && !routedInstanceIds.has(entry.instanceId),
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{props.existing === null ? "New Profile" : "Edit Profile"}</DialogTitle>
          <DialogDescription>
            A reusable execution preset. Provider configurations adapt it to each backend.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6">
          <div className="grid gap-4">
            <label className="grid gap-1.5">
              <span className="font-medium text-sm">Name</span>
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                    ...(current.slugTouched
                      ? {}
                      : { slug: slugifyAgentProfileName(event.target.value) }),
                  }))
                }
                placeholder="Reviewer Pre-Commit"
              />
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="font-medium text-sm">Shortcut</span>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground text-sm">
                    #
                  </span>
                  <Input
                    className="pl-7"
                    value={draft.slug}
                    onChange={(event) =>
                      update({
                        slug: event.target.value.toLowerCase(),
                        slugTouched: true,
                      })
                    }
                    placeholder="reviewer"
                  />
                </div>
              </label>
              <label className="grid gap-1.5">
                <span className="font-medium text-sm">Description</span>
                <Input
                  value={draft.description}
                  onChange={(event) => update({ description: event.target.value })}
                  placeholder="Review changes before committing."
                />
              </label>
            </div>
            <label className="flex items-center justify-between gap-4">
              <span className="grid gap-0.5">
                <span className="font-medium text-sm">Enabled</span>
                <span className="text-muted-foreground text-xs">
                  Disabled profiles stay in the library but cannot be selected in the composer.
                </span>
              </span>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
                aria-label="Enabled"
              />
            </label>
          </div>

          <div className="grid gap-3 border-t border-border/60 pt-4">
            <h3 className="font-medium text-sm">Base configuration</h3>
            <label className="grid gap-1.5">
              <span className="text-muted-foreground text-xs">Reasoning effort</span>
              <Input
                value={draft.reasoningEffort}
                onChange={(event) => update({ reasoningEffort: event.target.value })}
                placeholder="Inherit current"
              />
            </label>
            <div className="grid gap-1.5">
              <span className="text-muted-foreground text-xs">Mini Skills</span>
              {props.miniSkills.length === 0 ? (
                <span className="text-muted-foreground/80 text-xs">
                  No Mini Skills in the library yet.
                </span>
              ) : (
                <ul className="grid gap-1">
                  {props.miniSkills.map((skill) => (
                    <li key={skill.id}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={draft.miniSkillIds.includes(skill.id)}
                          onCheckedChange={(checked) =>
                            update({
                              miniSkillIds:
                                checked === true
                                  ? [...draft.miniSkillIds, skill.id]
                                  : draft.miniSkillIds.filter((id) => id !== skill.id),
                            })
                          }
                        />
                        <span className="min-w-0 truncate">{skill.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <label className="grid gap-1.5">
              <span className="text-muted-foreground text-xs">Instructions (Markdown)</span>
              <Textarea
                value={draft.instructions}
                onChange={(event) => update({ instructions: event.target.value })}
                rows={8}
                className="font-mono text-xs"
                placeholder="Act as a pre-commit reviewer…"
              />
            </label>
          </div>

          <div className="grid gap-3 border-t border-border/60 pt-4">
            <h3 className="font-medium text-sm">Provider configurations</h3>
            <p className="text-muted-foreground text-xs">
              Route this profile to concrete models per provider. Without a matching configuration,
              the profile keeps the provider's current model.
            </p>
            {draft.routes.map((route) => (
              <RouteEditor
                key={route.id}
                route={route}
                instanceEntries={props.instanceEntries}
                onChange={(patch) => updateRoute(route.id, patch)}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    routes: current.routes.filter((entry) => entry.id !== route.id),
                  }))
                }
              />
            ))}
            {availableInstances.length > 0 ? (
              <div>
                <AddPickerSelect
                  value=""
                  label="Add provider configuration"
                  options={availableInstances.map((entry) => ({
                    value: entry.instanceId,
                    label: entry.displayName,
                  }))}
                  onPick={(value) => {
                    setDraft((current) => ({
                      ...current,
                      routes: [
                        ...current.routes,
                        {
                          id: `route-${randomUUID()}`,
                          instanceId: value as ProviderInstanceId,
                          modelCandidates: [],
                          reasoningEffort: "",
                        },
                      ],
                    }));
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 border-t border-border/60 pt-4">
            <h3 className="font-medium text-sm">Prompt template</h3>
            <label className="flex items-center justify-between gap-4">
              <span className="grid gap-0.5">
                <span className="text-muted-foreground text-xs">Use custom template</span>
                <span className="text-muted-foreground/80 text-xs">
                  Off uses the default wrapper from Settings.
                </span>
              </span>
              <Switch
                checked={draft.useCustomTemplate}
                onCheckedChange={(checked) => update({ useCustomTemplate: Boolean(checked) })}
                aria-label="Use custom template"
              />
            </label>
            {draft.useCustomTemplate ? (
              <Textarea
                value={draft.promptTemplate}
                onChange={(event) => update({ promptTemplate: event.target.value })}
                rows={10}
                className="font-mono text-xs"
                aria-label="Custom prompt template"
              />
            ) : null}
          </div>

          {issues.length > 0 ? (
            <ul className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              {issues.map((issue) => (
                <li key={issue.message} className="text-destructive text-xs">
                  {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={issues.length > 0} onClick={() => props.onSave(draft, props.existing)}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Action-style picker: the trigger label never becomes a value, and the popup
 * always closes after a pick. An explicitly controlled open state avoids the
 * popup lingering when the picked option disappears from the list (the
 * provider route editor removes routed instances).
 */
function AddPickerSelect(props: {
  readonly value: string;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Select
      value={props.value}
      open={open}
      onOpenChange={(nextOpen) => setOpen(nextOpen)}
      onValueChange={(value) => {
        if (!value) return;
        setOpen(false);
        props.onPick(value);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-64">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            <PlusIcon className="size-3.5" />
            {props.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} hideIndicator value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function RouteEditor(props: {
  readonly route: AgentProfileRouteDraft;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onChange: (patch: Partial<AgentProfileRouteDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { route } = props;
  const instance = props.instanceEntries.find((entry) => entry.instanceId === route.instanceId);
  const instanceModels = useMemo(() => instance?.models ?? [], [instance]);
  const candidateSet = new Set(route.modelCandidates);
  const addableModels = instanceModels.filter((model) => !candidateSet.has(model.slug));

  const moveCandidate = (index: number, offset: -1 | 1) => {
    const next = [...route.modelCandidates];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    const [entry] = next.splice(index, 1);
    next.splice(target, 0, entry!);
    props.onChange({ modelCandidates: next });
  };

  return (
    <div className="grid gap-3 rounded-lg border border-border/60 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-medium text-sm">
          {instance?.displayName ?? `${route.instanceId} (unavailable)`}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Remove configuration"
          onClick={props.onRemove}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-1.5">
        <span className="text-muted-foreground text-xs">Model candidates</span>
        {route.modelCandidates.length === 0 ? (
          <span className="text-muted-foreground/80 text-xs">
            No candidates — the profile keeps this provider's current model.
          </span>
        ) : (
          <ul className="grid gap-1">
            {route.modelCandidates.map((slug, index) => {
              const model = instanceModels.find((candidate) => candidate.slug === slug);
              return (
                <li
                  key={slug}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1"
                >
                  <span className="w-16 shrink-0 text-muted-foreground text-xs">
                    {index === 0 ? "Primary" : `Fallback ${index}`}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {model?.name ?? slug}
                    {model ? null : (
                      <span className="text-destructive text-xs"> (unavailable)</span>
                    )}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${slug} up`}
                    disabled={index === 0}
                    onClick={() => moveCandidate(index, -1)}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${slug} down`}
                    disabled={index === route.modelCandidates.length - 1}
                    onClick={() => moveCandidate(index, 1)}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${slug}`}
                    onClick={() =>
                      props.onChange({
                        modelCandidates: route.modelCandidates.filter(
                          (candidate) => candidate !== slug,
                        ),
                      })
                    }
                  >
                    <XIcon className="size-3" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {addableModels.length > 0 ? (
          <AddPickerSelect
            value=""
            label="Add model candidate"
            options={addableModels.map((model) => ({ value: model.slug, label: model.name }))}
            onPick={(value) => {
              props.onChange({ modelCandidates: [...route.modelCandidates, value] });
            }}
          />
        ) : null}
      </div>
      <label className="grid gap-1.5">
        <span className="text-muted-foreground text-xs">Reasoning effort</span>
        <Input
          value={route.reasoningEffort}
          onChange={(event) => props.onChange({ reasoningEffort: event.target.value })}
          placeholder="Inherit base"
        />
      </label>
    </div>
  );
}
