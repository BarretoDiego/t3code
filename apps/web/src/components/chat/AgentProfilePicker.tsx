import { memo, useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, UserCogIcon } from "lucide-react";
import type { AgentProfile, AgentProfileId, EnvironmentId } from "@t3tools/contracts";
import type { AgentProfileResolution } from "@t3tools/shared/agentProfiles";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { cn } from "~/lib/utils";

/**
 * Composer footer control for the execution profile: Custom (the existing
 * manual behavior) or one of the library profiles. Selection is per-thread
 * draft state and persists across sends; the resolved model/effort details
 * surface in the popup for the active profile.
 */
export const AgentProfilePicker = memo(function AgentProfilePicker(props: {
  composerDraftTarget: ComposerThreadTarget;
  environmentId: EnvironmentId;
  resolution: AgentProfileResolution | null;
  size?: ComposerControlSize;
  hidden?: boolean;
}) {
  const size = props.size ?? "sm";
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(props.hidden);
  const agentProfiles = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.agentProfiles,
  );
  const selectedProfileId = useComposerDraftStore(
    (store) => store.getComposerDraft(props.composerDraftTarget)?.selectedProfileId ?? null,
  );
  const setSelectedProfileId = useComposerDraftStore((store) => store.setSelectedProfileId);

  const enabledProfiles = agentProfiles.filter((profile) => profile.enabled);
  const selectedProfile =
    enabledProfiles.find((profile) => profile.id === selectedProfileId) ?? null;
  // A deleted or disabled profile id safely reads as Custom.
  const effectiveValue = selectedProfile?.id ?? "";

  const selectProfile = useCallback(
    (value: string) => {
      setSelectedProfileId(
        props.composerDraftTarget,
        value === "" ? null : (value as AgentProfileId),
      );
    },
    [props.composerDraftTarget, setSelectedProfileId],
  );

  const resolution = props.resolution;
  const unavailable = resolution?.status === "unavailable" ? resolution : null;

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            variant="ghost"
            className={cn(
              "shrink-0 whitespace-nowrap",
              unavailable && "text-destructive hover:text-destructive",
            )}
            aria-label={selectedProfile ? `Profile: ${selectedProfile.name}` : "Profile: Custom"}
          />
        }
      >
        <ComposerControlIcon icon={unavailable ? CircleAlertIcon : UserCogIcon} size={size} />
        <span className="max-w-28 truncate">
          {selectedProfile ? selectedProfile.name : "Custom"}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64" {...composerFloatingLayerProps}>
        <MenuRadioGroup value={effectiveValue} onValueChange={selectProfile}>
          <MenuGroup>
            <MenuRadioItem value="" hideIndicator closeOnClick>
              <span className="flex w-full min-w-0 flex-col">
                <span className="min-w-0 truncate">Custom</span>
                <span className="max-w-64 text-pretty text-muted-foreground/80 text-xs">
                  Manual control over model, effort, and Mini Skills.
                </span>
              </span>
            </MenuRadioItem>
          </MenuGroup>
          {enabledProfiles.length > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            {enabledProfiles.map((profile) => (
              <MenuRadioItem key={profile.id} value={profile.id} hideIndicator closeOnClick>
                <span className="flex w-full min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{profile.name}</span>
                    <span className="shrink-0 text-muted-foreground/70 text-xs">
                      #{profile.slug}
                    </span>
                  </span>
                  {profile.description.length > 0 ? (
                    <span className="max-w-64 truncate text-muted-foreground/80 text-xs">
                      {profile.description}
                    </span>
                  ) : null}
                </span>
              </MenuRadioItem>
            ))}
          </MenuGroup>
        </MenuRadioGroup>
        {resolution?.status === "resolved" && selectedProfile ? (
          <>
            <MenuSeparator />
            <ResolvedProfileSummary profile={selectedProfile} resolution={resolution} />
          </>
        ) : null}
        {unavailable ? (
          <>
            <MenuSeparator />
            <div className="max-w-64 px-2 py-1.5 text-pretty text-destructive text-xs">
              {unavailable.reason}
            </div>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem closeOnClick onClick={() => void navigate({ to: "/settings/agent-profiles" })}>
          Manage Profiles
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

function ResolvedProfileSummary(props: {
  profile: AgentProfile;
  resolution: Extract<AgentProfileResolution, { status: "resolved" }>;
}) {
  const { resolution } = props;
  const rows: Array<{ label: string; value: string }> = [
    { label: "Model", value: resolution.modelSelection.model },
    ...(resolution.diagnostics.requestedReasoningEffort !== null
      ? [
          {
            label: "Reasoning",
            value: resolution.diagnostics.reasoningEffortSkippedAsUnsupported
              ? `${resolution.diagnostics.requestedReasoningEffort} (not supported, skipped)`
              : resolution.diagnostics.requestedReasoningEffort,
          },
        ]
      : []),
    ...(resolution.miniSkillIds.length > 0
      ? [{ label: "Mini Skills", value: String(resolution.miniSkillIds.length) }]
      : []),
  ];
  return (
    <div className="grid gap-1 px-2 py-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 text-xs">
          <span className="text-muted-foreground/80">{row.label}</span>
          <span className="min-w-0 truncate font-medium">{row.value}</span>
        </div>
      ))}
      {resolution.diagnostics.fallbackIndex !== null && resolution.diagnostics.fallbackIndex > 0 ? (
        <div className="max-w-64 text-pretty text-muted-foreground/80 text-xs">
          Primary model unavailable — using fallback #{resolution.diagnostics.fallbackIndex}.
        </div>
      ) : null}
    </div>
  );
}
