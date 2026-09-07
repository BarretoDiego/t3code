import { useState } from "react";
import type { EnvironmentId, ProjectId, RemoteRepositoryRef } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { HubSelect } from "./HubSelect";

export function RepositoryMappingDialog({
  environmentId,
  label,
  reference,
  onChanged,
}: {
  environmentId: EnvironmentId;
  label: string;
  reference: RemoteRepositoryRef;
  onChanged: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const save = useAtomCommand(serverEnvironment.sourceControlHubMapRepository);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | "">("");
  const [remoteName, setRemoteName] = useState("origin");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" disabled={!projects.length} onClick={() => setOpen(true)}>
        Associate project in {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Associate local clone</DialogTitle>
            <DialogDescription>
              {reference.repository} · {label}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!projectId || !remoteName.trim() || pending) return;
              setPending(true);
              setError(false);
              try {
                const result = await save({
                  environmentId,
                  input: { projectId, remoteName: remoteName.trim(), reference },
                });
                if (result._tag === "Success") {
                  onChanged();
                  setOpen(false);
                } else setError(true);
              } finally {
                setPending(false);
              }
            }}
          >
            <DialogPanel className="space-y-4">
              <HubSelect
                label="Local project"
                value={projectId}
                options={[
                  { value: "" as const, label: "Choose a project" },
                  ...projects.map((project) => ({ value: project.id, label: project.title })),
                ]}
                onChange={setProjectId}
              />
              <label className="grid gap-2 text-sm">
                Existing Git remote
                <Input
                  required
                  value={remoteName}
                  onChange={(event) => setRemoteName(event.target.value)}
                />
              </label>
              <p className="text-sm text-muted-foreground">
                Overrides automatic repository identification for this project remote. The Git
                remote URL remains unchanged.
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  Could not associate this clone. Check that the project has the specified Git
                  remote and that its environment is online.
                </p>
              )}
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !projectId || !remoteName.trim()}>
                {pending ? "Saving…" : "Associate clone"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
