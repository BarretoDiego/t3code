import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { HubSelect } from "../sourceControl/HubSelect";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";

export function SourceControlReviewSettingsSection() {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const review = settings.sourceControlReview;
  const save = (patch: Partial<typeof review>) =>
    update({ sourceControlReview: { ...review, ...patch } });
  return (
    <SettingsSection title="AI review">
      <div className="grid gap-4 sm:grid-cols-2">
        <HubSelect
          label="Default review tier"
          value={review.tier}
          options={[
            { value: "quick", label: "Quick · sampled changes" },
            { value: "standard", label: "Standard · changed files" },
            { value: "deep", label: "Deep · repository context" },
            { value: "exhaustive", label: "Exhaustive · additional analysis passes" },
          ]}
          onChange={(tier) => save({ tier })}
        />
        <HubSelect
          label="Default Agent Profile"
          value={review.profileId ?? ""}
          options={[
            { value: "", label: "Custom" },
            ...settings.agentProfiles.map((profile) => ({
              value: profile.id,
              label: profile.name,
            })),
          ]}
          onChange={(id) =>
            save({
              profileId: settings.agentProfiles.find((profile) => profile.id === id)?.id ?? null,
            })
          }
        />
        <HubSelect
          label="Default severity threshold"
          value={review.severityThreshold}
          options={["critical", "major", "minor", "suggestion", "info"].map((value) => ({
            value: value as typeof review.severityThreshold,
            label: value,
          }))}
          onChange={(severityThreshold) => save({ severityThreshold })}
        />
      </div>
      <div className="mt-4 space-y-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={review.includeExistingComments}
            onCheckedChange={(includeExistingComments) => save({ includeExistingComments })}
          />
          Include existing comments to avoid duplicates
        </label>
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={review.includeGenerated}
            onCheckedChange={(includeGenerated) => save({ includeGenerated })}
          />
          Include generated files and lockfiles
        </label>
      </div>
    </SettingsSection>
  );
}
