import { memo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
import type { EnvironmentId, MiniSkillId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const EMPTY_SELECTION: ReadonlyArray<MiniSkillId> = [];

/**
 * Shared mini skill checkbox list. Rendered inside the composer's own picker
 * popup and inside the compact overflow menu, so both surfaces toggle the
 * same draft selection.
 */
export const MiniSkillsMenuContent = memo(function MiniSkillsMenuContent(props: {
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const miniSkills = useEnvironmentSettings(props.environmentId, (settings) => settings.miniSkills);
  const selectedMiniSkillIds = useComposerDraftStore(
    (store) =>
      store.getComposerDraft(props.composerDraftTarget)?.selectedMiniSkillIds ?? EMPTY_SELECTION,
  );
  const setSelectedMiniSkillIds = useComposerDraftStore((store) => store.setSelectedMiniSkillIds);

  const toggleSkill = useCallback(
    (skillId: MiniSkillId, checked: boolean) => {
      const next = checked
        ? [...selectedMiniSkillIds, skillId]
        : selectedMiniSkillIds.filter((id) => id !== skillId);
      setSelectedMiniSkillIds(props.composerDraftTarget, next);
    },
    [props.composerDraftTarget, selectedMiniSkillIds, setSelectedMiniSkillIds],
  );

  if (miniSkills.length === 0) {
    return (
      <>
        <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
          Mini Skills
        </div>
        <div className="max-w-56 px-2 pb-1.5 text-muted-foreground/80 text-xs">
          Reusable instructions you can attach to a request. Create them in Settings.
        </div>
        <MenuSeparator />
        <MenuItem closeOnClick onClick={() => void navigate({ to: "/settings/mini-skills" })}>
          Create a Mini Skill
        </MenuItem>
      </>
    );
  }

  return (
    <>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Mini Skills</div>
      <MenuGroup>
        {miniSkills.map((skill) => (
          <MenuCheckboxItem
            key={skill.id}
            checked={selectedMiniSkillIds.includes(skill.id)}
            onCheckedChange={(checked) => toggleSkill(skill.id, checked === true)}
          >
            <span className="flex w-full min-w-0 flex-col">
              <span className="min-w-0 truncate">{skill.name}</span>
              {skill.description.length > 0 ? (
                <span className="max-w-56 truncate text-muted-foreground/80 text-xs">
                  {skill.description}
                </span>
              ) : null}
            </span>
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem closeOnClick onClick={() => void navigate({ to: "/settings/mini-skills" })}>
        Manage Mini Skills
      </MenuItem>
    </>
  );
});

/**
 * Composer footer control: request-scoped mini skill selection. The trigger
 * stays compact — a bare icon at rest, icon plus count once anything is
 * selected.
 */
export const MiniSkillsPicker = memo(function MiniSkillsPicker(props: {
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
  size?: ComposerControlSize;
  hidden?: boolean;
}) {
  const size = props.size ?? "sm";
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(props.hidden);
  const selectedCount = useComposerDraftStore(
    (store) => store.getComposerDraft(props.composerDraftTarget)?.selectedMiniSkillIds.length ?? 0,
  );

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            variant="ghost"
            className="shrink-0 whitespace-nowrap"
            aria-label={
              selectedCount > 0
                ? `Mini Skills, ${selectedCount} selected`
                : "Attach a Mini Skill to this request"
            }
          />
        }
      >
        <ComposerControlIcon icon={SparklesIcon} size={size} />
        {selectedCount > 0 ? <span>{selectedCount}</span> : null}
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
        {...composerFloatingLayerProps}
      >
        <MiniSkillsMenuContent
          composerDraftTarget={props.composerDraftTarget}
          environmentId={props.environmentId}
        />
      </MenuPopup>
    </Menu>
  );
});
