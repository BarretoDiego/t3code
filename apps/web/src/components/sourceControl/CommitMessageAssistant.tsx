import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MiniSkillId } from "@t3tools/contracts";
import { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { HubSelect } from "./HubSelect";

export function CommitMessageAssistant({
  environmentId,
  cwd,
  filePaths,
  onGenerated,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  filePaths?: readonly string[];
  onGenerated: (message: string) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const defaultModel = resolveSourceControlWriterModelSelection(settings, providers);
  const [instanceId, setInstanceId] = useState(defaultModel.instanceId);
  const [model, setModel] = useState(defaultModel.model);
  const [profileId, setProfileId] = useState("");
  const [skills, setSkills] = useState<MiniSkillId[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = useAtomCommand(serverEnvironment.sourceControlHubCommitPreview);
  const provider = providers.find((provider) => provider.instanceId === instanceId);
  const selectedModel = provider?.models.find((item) => item.slug === model) ?? provider?.models[0];
  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-xs font-medium">Generate message with agent</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Uses the configured writing style. Previewing preserves your current staging and does not
          commit.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <HubSelect
            label="Commit writer"
            value={instanceId}
            options={providers
              .filter((provider) => provider.enabled && provider.supportsTextGeneration !== false)
              .map((provider) => ({
                value: provider.instanceId,
                label: provider.displayName ?? provider.driver,
              }))}
            onChange={setInstanceId}
          />
          <HubSelect
            label="Commit model"
            value={selectedModel?.slug ?? ""}
            options={
              provider?.models.map((model) => ({ value: model.slug, label: model.name })) ?? []
            }
            onChange={setModel}
          />
          <HubSelect
            label="Commit Agent Profile"
            value={profileId}
            options={[
              { value: "", label: "Custom" },
              ...settings.agentProfiles
                .filter((profile) => profile.enabled)
                .map((profile) => ({
                  value: profile.id,
                  label: profile.name,
                })),
            ]}
            onChange={setProfileId}
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {settings.miniSkills.map((skill) => (
            <label key={skill.id} className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={skills.includes(skill.id)}
                onCheckedChange={(checked) =>
                  setSkills((current) =>
                    checked ? [...current, skill.id] : current.filter((id) => id !== skill.id),
                  )
                }
              />
              {skill.name}
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !selectedModel || filePaths?.length === 0}
          onClick={async () => {
            if (!selectedModel || pending) return;
            setPending(true);
            setError(null);
            try {
              const profile = settings.agentProfiles.find((profile) => profile.id === profileId);
              const result = await generate({
                environmentId,
                input: {
                  cwd,
                  ...(filePaths ? { filePaths } : {}),
                  agent: {
                    modelSelection: { instanceId, model: selectedModel.slug },
                    miniSkillIds: skills,
                    ...(profile ? { profileId: profile.id } : {}),
                  },
                },
              });
              if (result._tag === "Success") onGenerated(result.value.message);
              else setError("Could not generate a message. Check the agent and selected files.");
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Generating…" : "Generate preview"}
        </Button>
      </div>
    </details>
  );
}
