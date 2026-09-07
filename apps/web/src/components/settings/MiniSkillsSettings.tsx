import { useId, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  DEFAULT_MINI_SKILL_PROMPT_WRAPPERS,
  MiniSkillId,
  type MiniSkill,
} from "@t3tools/contracts";
import { hasMiniSkillsPlaceholder } from "@t3tools/shared/miniSkills";
import { MINI_SKILLS_WRAPPER_PLACEHOLDER } from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface MiniSkillDraft {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly enabledByDefaultForNewThreads: boolean;
}

const EMPTY_SKILL_DRAFT: MiniSkillDraft = {
  name: "",
  description: "",
  content: "",
  enabledByDefaultForNewThreads: false,
};

function MiniSkillEditorDialog(props: {
  readonly skill: MiniSkill | "new" | null;
  readonly onClose: () => void;
  readonly onSave: (draft: MiniSkillDraft, existing: MiniSkill | null) => void;
}) {
  if (props.skill === null) {
    return null;
  }
  const existing = props.skill === "new" ? null : props.skill;
  return (
    <MiniSkillEditorDialogContent
      existing={existing}
      onClose={props.onClose}
      onSave={props.onSave}
    />
  );
}

function MiniSkillEditorDialogContent(props: {
  readonly existing: MiniSkill | null;
  readonly onClose: () => void;
  readonly onSave: (draft: MiniSkillDraft, existing: MiniSkill | null) => void;
}) {
  const { existing } = props;
  const formId = useId();
  const [draft, setDraft] = useState<MiniSkillDraft>(() =>
    existing === null
      ? EMPTY_SKILL_DRAFT
      : {
          name: existing.name,
          description: existing.description,
          content: existing.content,
          enabledByDefaultForNewThreads: existing.enabledByDefaultForNewThreads,
        },
  );
  const nameInvalid = draft.name.trim().length === 0;
  const contentInvalid = draft.content.trim().length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-h-[min(calc(100dvh-4rem),56rem)] max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{existing === null ? "New Mini Skill" : "Edit Mini Skill"}</DialogTitle>
          <DialogDescription>
            A reusable block of Markdown instructions you can attach to threads and requests.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!nameInvalid && !contentInvalid) props.onSave(draft, existing);
            }}
          >
            <label className="grid gap-1.5">
              <span className="font-medium text-sm">Name</span>
              <Input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Create Isolated Feature Workspace"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="font-medium text-sm">Description</span>
              <Input
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="What this instruction does, in one line"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="font-medium text-sm">Content</span>
              <Textarea
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                rows={10}
                placeholder="Markdown instructions for the agent."
                className="font-mono text-xs"
              />
            </label>
            <label className="flex items-center justify-between gap-4">
              <span className="grid gap-0.5">
                <span className="font-medium text-sm">Enable by default for new threads</span>
                <span className="text-muted-foreground text-xs">
                  A snapshot of this skill is attached to every new thread. Existing threads keep
                  the version they were created with.
                </span>
              </span>
              <Switch
                checked={draft.enabledByDefaultForNewThreads}
                onCheckedChange={(checked) =>
                  setDraft({ ...draft, enabledByDefaultForNewThreads: Boolean(checked) })
                }
                aria-label="Enable by default for new threads"
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter className="shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={nameInvalid || contentInvalid} type="submit" form={formId}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
function PromptWrapperEditor(props: {
  readonly scope: keyof typeof DEFAULT_MINI_SKILL_PROMPT_WRAPPERS;
  readonly title: string;
  readonly description: string;
  readonly value: string;
}) {
  const updateSettings = useUpdatePrimarySettings();
  const defaultWrapper = DEFAULT_MINI_SKILL_PROMPT_WRAPPERS[props.scope];
  const [draftText, setText] = useState(props.value);
  const [touched, setTouched] = useState(false);
  const text = touched ? draftText : props.value;
  const missingPlaceholder = !hasMiniSkillsPlaceholder(text);
  const isDirty = text !== props.value;

  const persist = () => {
    if (!isDirty) return;
    if (missingPlaceholder) {
      setTouched(true);
      return;
    }
    updateSettings({ miniSkillPromptWrappers: { [props.scope]: text } });
    setTouched(false);
  };

  return (
    <div className="grid min-w-0 gap-3 p-3 sm:p-4">
      <div className="grid gap-0.5">
        <span className="font-medium text-sm">{props.title}</span>
        <span className="text-muted-foreground text-xs">{props.description}</span>
      </div>
      <Textarea
        value={text}
        rows={8}
        className="font-mono text-xs"
        aria-label={props.title}
        onChange={(event) => {
          setText(event.target.value);
          setTouched(true);
        }}
        onBlur={persist}
      />
      <div className="flex min-h-6 items-center justify-between gap-3">
        <span className="text-destructive text-xs">
          {touched && missingPlaceholder
            ? `The wrapper must contain ${MINI_SKILLS_WRAPPER_PLACEHOLDER} where the skills are inserted.`
            : null}
        </span>
        {text !== defaultWrapper ? (
          <SettingResetButton
            label={`${props.title.toLowerCase()} wrapper`}
            onClick={() => {
              setText(defaultWrapper);
              setTouched(false);
              updateSettings({ miniSkillPromptWrappers: { [props.scope]: defaultWrapper } });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function MiniSkillsSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const miniSkills = settings.miniSkills;
  const [editingSkill, setEditingSkill] = useState<MiniSkill | "new" | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<MiniSkill | null>(null);

  const persistLibrary = (next: ReadonlyArray<MiniSkill>) => {
    updateSettings({ miniSkills: [...next] });
  };

  const handleSave = (draft: MiniSkillDraft, existing: MiniSkill | null) => {
    const now = new Date().toISOString();
    if (existing === null) {
      persistLibrary([
        ...miniSkills,
        {
          id: MiniSkillId.make(`skill-${randomUUID()}`),
          name: draft.name.trim(),
          description: draft.description.trim(),
          content: draft.content,
          enabledByDefaultForNewThreads: draft.enabledByDefaultForNewThreads,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    } else {
      persistLibrary(
        miniSkills.map((skill) =>
          skill.id === existing.id
            ? {
                ...skill,
                name: draft.name.trim(),
                description: draft.description.trim(),
                content: draft.content,
                enabledByDefaultForNewThreads: draft.enabledByDefaultForNewThreads,
                updatedAt: now,
              }
            : skill,
        ),
      );
    }
    setEditingSkill(null);
  };

  const handleDelete = (skill: MiniSkill) => {
    persistLibrary(miniSkills.filter((entry) => entry.id !== skill.id));
    setDeletingSkill(null);
    toastManager.add({
      type: "success",
      title: `Deleted "${skill.name}"`,
      description: "Threads that already use this skill keep their snapshot of it.",
    });
  };

  const toggleEnabledByDefault = (skill: MiniSkill, enabled: boolean) => {
    persistLibrary(
      miniSkills.map((entry) =>
        entry.id === skill.id
          ? {
              ...entry,
              enabledByDefaultForNewThreads: enabled,
              updatedAt: new Date().toISOString(),
            }
          : entry,
      ),
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("mini-skills")}
        description="Reusable instructions that can be attached to threads and requests."
        headerAction={
          <Button size="xs" variant="outline" onClick={() => setEditingSkill("new")}>
            <PlusIcon className="size-3.5" />
            New Mini Skill
          </Button>
        }
      >
        {miniSkills.length === 0 ? (
          <div className="px-3 py-6 text-muted-foreground text-sm sm:px-4">
            No Mini Skills yet. Create one to reuse instructions across threads and requests.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {miniSkills.map((skill) => (
              <li
                key={skill.id}
                className="group/row flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4"
              >
                <div className="grid min-w-0 flex-1 basis-40 gap-0.5">
                  <span className="truncate font-medium text-sm">{skill.name}</span>
                  {skill.description.length > 0 ? (
                    <span className="truncate text-muted-foreground text-xs">
                      {skill.description}
                    </span>
                  ) : null}
                </div>
                <label className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
                  New threads
                  <Switch
                    checked={skill.enabledByDefaultForNewThreads}
                    onCheckedChange={(checked) => toggleEnabledByDefault(skill, Boolean(checked))}
                    aria-label={`Enable ${skill.name} by default for new threads`}
                  />
                </label>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit ${skill.name}`}
                    onClick={() => setEditingSkill(skill)}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${skill.name}`}
                    onClick={() => setDeletingSkill(skill)}
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
        {...searchableSetting("mini-skills-prompt-wrappers")}
        description={`The text surrounding Mini Skills when they are sent to the agent. ${MINI_SKILLS_WRAPPER_PLACEHOLDER} marks where the skills are inserted.`}
      >
        <PromptWrapperEditor
          scope="thread"
          title="Thread instructions"
          description="Wraps Mini Skills enabled by default, sent with the first message of a thread."
          value={settings.miniSkillPromptWrappers.thread}
        />
        <PromptWrapperEditor
          scope="request"
          title="Request instructions"
          description="Wraps Mini Skills selected in the composer, sent with that message only."
          value={settings.miniSkillPromptWrappers.request}
        />
      </SettingsSection>

      <MiniSkillEditorDialog
        skill={editingSkill}
        onClose={() => setEditingSkill(null)}
        onSave={handleSave}
      />

      <AlertDialog
        open={deletingSkill !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingSkill(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              Delete "{deletingSkill?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the Mini Skill from your library. Threads that already use it keep the
              snapshot captured when they were created.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingSkill) handleDelete(deletingSkill);
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
