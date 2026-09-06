import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  AgentProfileId,
  DEFAULT_AGENT_PROFILE_WRAPPER,
  isValidAgentProfileTemplate,
  type AgentProfile,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { primaryServerProvidersAtom } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  AgentProfileEditorDialog,
  emptyAgentProfileDraft,
  profileDraftFromProfile,
  type AgentProfileDraft,
} from "./AgentProfileEditorDialog";

type EditorState = { readonly existing: AgentProfile | null; readonly draft: AgentProfileDraft };

export function AgentProfilesSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const agentProfiles = settings.agentProfiles;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<AgentProfile | null>(null);
  const defaultWrapper = settings.agentProfileDefaultWrapper;
  const [wrapperText, setWrapperText] = useState(defaultWrapper);
  const [wrapperTouched, setWrapperTouched] = useState(false);
  const wrapperInvalid = !isValidAgentProfileTemplate(wrapperText);

  const persistProfiles = (next: ReadonlyArray<AgentProfile>) => {
    updateSettings({ agentProfiles: [...next] });
  };

  const handleSave = (draft: AgentProfileDraft, existing: AgentProfile | null) => {
    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: existing?.id ?? AgentProfileId.make(`profile-${randomUUID()}`),
      name: draft.name.trim(),
      slug: draft.slug.trim() as AgentProfile["slug"],
      description: draft.description.trim(),
      enabled: draft.enabled,
      ...(draft.reasoningEffort.trim().length > 0
        ? { reasoningEffort: draft.reasoningEffort.trim() }
        : {}),
      miniSkillIds: draft.miniSkillIds,
      instructions: draft.instructions,
      ...(draft.useCustomTemplate ? { promptTemplate: draft.promptTemplate } : {}),
      routes: draft.routes.flatMap((route) =>
        route.instanceId === null
          ? []
          : [
              {
                id: route.id,
                instanceId: route.instanceId,
                modelCandidates: route.modelCandidates,
                ...(route.reasoningEffort.trim().length > 0
                  ? { reasoningEffort: route.reasoningEffort.trim() }
                  : {}),
              },
            ],
      ),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing === null) {
      persistProfiles([...agentProfiles, profile]);
    } else {
      persistProfiles(agentProfiles.map((entry) => (entry.id === existing.id ? profile : entry)));
    }
    setEditor(null);
  };

  const handleDelete = (profile: AgentProfile) => {
    persistProfiles(agentProfiles.filter((entry) => entry.id !== profile.id));
    setDeletingProfile(null);
    toastManager.add({
      type: "success",
      title: `Deleted "${profile.name}"`,
      description: "Threads using it fall back to Custom.",
    });
  };

  const toggleEnabled = (profile: AgentProfile, enabled: boolean) => {
    persistProfiles(
      agentProfiles.map((entry) =>
        entry.id === profile.id
          ? { ...entry, enabled, updatedAt: new Date().toISOString() }
          : entry,
      ),
    );
  };

  const openNewProfile = () => setEditor({ existing: null, draft: emptyAgentProfileDraft() });
  const openEditProfile = (profile: AgentProfile) =>
    setEditor({ existing: profile, draft: profileDraftFromProfile(profile) });
  const openDuplicateProfile = (profile: AgentProfile) => {
    const draft = profileDraftFromProfile(profile);
    draft.name = `${profile.name} copy`;
    draft.slug = "";
    draft.slugTouched = false;
    setEditor({ existing: null, draft });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("agent-profiles")}
        description="Reusable execution presets: provider-aware model routing, reasoning effort, Mini Skills, and instructions."
        headerAction={
          <Button size="sm" variant="outline" onClick={openNewProfile}>
            <PlusIcon className="size-3.5" />
            New Profile
          </Button>
        }
      >
        {agentProfiles.length === 0 ? (
          <div className="px-4 py-6 text-muted-foreground text-sm">
            No profiles yet. Create one to turn recurring composer setups into a preset.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {agentProfiles.map((profile) => (
              <li key={profile.id} className="group/row flex items-center gap-4 px-3 py-3 sm:px-4">
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-sm">{profile.name}</span>
                    <Badge variant="outline" className="shrink-0 font-normal">
                      #{profile.slug}
                    </Badge>
                    {profile.enabled ? null : (
                      <Badge variant="secondary" className="shrink-0 font-normal">
                        Disabled
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-muted-foreground text-xs">
                    {profile.description.length > 0 ? profile.description : "No description"}
                  </span>
                  <span className="truncate text-muted-foreground/70 text-xs">
                    {profile.routes.length} provider{" "}
                    {profile.routes.length === 1 ? "configuration" : "configurations"} ·{" "}
                    {profile.miniSkillIds.length} Mini{" "}
                    {profile.miniSkillIds.length === 1 ? "Skill" : "Skills"}
                    {profile.reasoningEffort !== undefined
                      ? ` · Reasoning: ${profile.reasoningEffort}`
                      : ""}
                  </span>
                </div>
                <Switch
                  className="shrink-0"
                  checked={profile.enabled}
                  onCheckedChange={(checked) => toggleEnabled(profile, Boolean(checked))}
                  aria-label={`Enable ${profile.name}`}
                />
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Duplicate ${profile.name}`}
                    onClick={() => openDuplicateProfile(profile)}
                  >
                    <CopyIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${profile.name}`}
                    onClick={() => openEditProfile(profile)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${profile.name}`}
                    onClick={() => setDeletingProfile(profile)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("agent-profiles-default-wrapper")}
        description="The template profiles use to wrap a request unless they define their own. {{user_message}} is required."
      >
        <div className="grid max-w-3xl gap-2 px-4 pb-4">
          <Textarea
            value={wrapperText}
            rows={10}
            className="font-mono text-xs"
            aria-label="Default profile wrapper"
            onChange={(event) => {
              setWrapperText(event.target.value);
              setWrapperTouched(true);
            }}
            onBlur={() => {
              if (wrapperInvalid || wrapperText === defaultWrapper) return;
              updateSettings({ agentProfileDefaultWrapper: wrapperText });
              setWrapperTouched(false);
            }}
          />
          <div className="flex min-h-6 items-center justify-between gap-3">
            <span className="text-destructive text-xs">
              {wrapperTouched && wrapperInvalid
                ? "The wrapper must contain {{user_message}} where the request is inserted."
                : null}
            </span>
            {wrapperText !== DEFAULT_AGENT_PROFILE_WRAPPER ? (
              <SettingResetButton
                label="default profile wrapper"
                onClick={() => {
                  setWrapperText(DEFAULT_AGENT_PROFILE_WRAPPER);
                  setWrapperTouched(false);
                  updateSettings({ agentProfileDefaultWrapper: DEFAULT_AGENT_PROFILE_WRAPPER });
                }}
              />
            ) : null}
          </div>
        </div>
      </SettingsSection>

      {editor !== null ? (
        <AgentProfileEditorDialog
          existing={editor.existing}
          initialDraft={editor.draft}
          existingProfiles={agentProfiles}
          instanceEntries={instanceEntries}
          miniSkills={settings.miniSkills}
          onClose={() => setEditor(null)}
          onSave={handleSave}
        />
      ) : null}

      <AlertDialog
        open={deletingProfile !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingProfile(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingProfile?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Threads with this profile selected fall back to Custom. Turns already sent keep the
              configuration they ran with.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingProfile) handleDelete(deletingProfile);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
