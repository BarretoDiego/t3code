import { useGitStackedAction } from "../../lib/sourceControlActions";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { vcsEnvironment } from "../../state/vcs";
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

export function LocalCloneActions({
  environmentId,
  cwd,
  remoteName,
  onChanged,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  remoteName: string;
  onChanged: () => void;
}) {
  const push = useGitStackedAction({ environmentId, cwd });
  const fetch = useAtomCommand(vcsEnvironment.fetch);
  const pull = useAtomCommand(vcsEnvironment.pull);
  const switchRef = useAtomCommand(vcsEnvironment.switchRef);
  const createRef = useAtomCommand(vcsEnvironment.createRef);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"fetch" | "pull" | "push" | "checkout" | "create">("fetch");
  const [branch, setBranch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Local Git actions
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Local repository</DialogTitle>
            <DialogDescription className="break-all">{cwd}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setPending(true);
              setError(null);
              try {
                const result =
                  action === "push"
                    ? await push.run({ actionId: randomUUID(), action: "push" })
                    : action === "fetch"
                      ? await fetch({ environmentId, input: { cwd, remoteName } })
                      : action === "pull"
                        ? await pull({ environmentId, input: { cwd } })
                        : action === "checkout"
                          ? await switchRef({
                              environmentId,
                              input: { cwd, refName: branch.trim() },
                            })
                          : await createRef({
                              environmentId,
                              input: { cwd, refName: branch.trim(), switchRef: true },
                            });
                if (result._tag === "Success") {
                  onChanged();
                  setOpen(false);
                } else
                  setError(
                    "Git could not complete this action. Check local changes, branch state and remote access.",
                  );
              } finally {
                setPending(false);
              }
            }}
          >
            <DialogPanel className="space-y-4">
              <HubSelect
                label="Git action"
                value={action}
                options={[
                  { value: "fetch", label: `Fetch ${remoteName}` },
                  { value: "pull", label: "Pull current branch" },
                  { value: "push", label: "Push current branch" },
                  { value: "checkout", label: "Checkout branch" },
                  { value: "create", label: "Create and checkout branch" },
                ]}
                onChange={setAction}
              />
              {(action === "checkout" || action === "create") && (
                <label className="grid gap-2 text-sm">
                  Branch
                  <Input
                    required
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>
              )}
              <p className="text-sm text-muted-foreground">
                {action === "fetch"
                  ? "Updates remote refs in this clone."
                  : action === "push"
                    ? "Pushes committed changes from this branch using its configured remote. Uncommitted changes are not included."
                    : "Applies to this local checkout. Git will preserve or reject conflicting local changes."}
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
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
              <Button
                type="submit"
                disabled={
                  pending || ((action === "checkout" || action === "create") && !branch.trim())
                }
              >
                {pending ? "Working…" : action === "push" ? "Confirm push" : "Run Git action"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
