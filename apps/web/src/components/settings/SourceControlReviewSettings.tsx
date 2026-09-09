import { useState } from "react";
import {
  DEFAULT_SOURCE_CONTROL_REVIEW_LANGUAGE,
  DEFAULT_SOURCE_CONTROL_REVIEW_PROMPT,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { DraftInput } from "../ui/draft-input";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { HubSelect } from "../sourceControl/HubSelect";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";

export function SourceControlReviewSettingsSection() {
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const review = settings.sourceControlReview;
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const save = (patch: Partial<typeof review>) =>
    update({ sourceControlReview: { ...review, ...patch } });
  return (
    <SettingsSection title="AI review">
      <div className="grid gap-4 sm:grid-cols-2">
        <HubSelect
          showLabel
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
          showLabel
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
          showLabel
          label="Default severity threshold"
          value={review.severityThreshold}
          options={["critical", "major", "minor", "suggestion", "info"].map((value) => ({
            value: value as typeof review.severityThreshold,
            label: value,
          }))}
          onChange={(severityThreshold) => save({ severityThreshold })}
        />
        <HubSelect
          showLabel
          label="Default reasoning effort"
          value={review.reasoningEffort}
          options={[
            { value: "", label: "Provider default" },
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra high" },
          ]}
          onChange={(reasoningEffort) => save({ reasoningEffort })}
        />
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">
          Review language
          <DraftInput
            aria-label="Review language"
            className="text-sm font-normal text-foreground"
            maxLength={100}
            placeholder={DEFAULT_SOURCE_CONTROL_REVIEW_LANGUAGE}
            value={review.language}
            onCommit={(language) =>
              save({ language: language.trim() || DEFAULT_SOURCE_CONTROL_REVIEW_LANGUAGE })
            }
          />
        </label>
      </div>
      <div className="mt-5 space-y-3 rounded-lg border p-4">
        <label className="grid gap-2 text-sm font-medium">
          Reviewer instructions
          <Textarea
            className="min-h-40 font-mono text-xs font-normal"
            value={promptDraft ?? review.prompt}
            maxLength={32_000}
            onChange={(event) => setPromptDraft(event.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Applied to new review runs. The agent decides how many findings are warranted. Results
          always remain drafts until you confirm publication.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={promptDraft === null || !promptDraft.trim() || promptDraft === review.prompt}
            onClick={() => save({ prompt: promptDraft ?? review.prompt })}
          >
            Save instructions
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPromptDraft(DEFAULT_SOURCE_CONTROL_REVIEW_PROMPT)}
          >
            Restore default
          </Button>
        </div>
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
