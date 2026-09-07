import { useState } from "react";
import type { EnvironmentId, RemoteRepositoryRef } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
export function CreatePullRequestDialog({
  environmentId,
  reference,
  defaultBranch,
  onClose,
  onCreated,
}: {
  environmentId: EnvironmentId;
  reference: RemoteRepositoryRef;
  defaultBranch: string;
  onClose: () => void;
  onCreated: (number: number) => void;
}) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState(defaultBranch);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewers, setReviewers] = useState("");
  const [draft, setDraft] = useState(false);
  const [pending, setPending] = useState(false);
  const [createdNumber, setCreatedNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useAtomCommand(serverEnvironment.sourceControlHubCreatePullRequest);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New pull request</DialogTitle>
          <DialogDescription>{reference.repository}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (createdNumber !== null) {
              onCreated(createdNumber);
              return;
            }
            if (pending) return;
            setPending(true);
            try {
              const result = await create({
                environmentId,
                input: {
                  ...reference,
                  source,
                  target,
                  title,
                  body,
                  draft,
                  reviewers: reviewers
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                },
              });
              if (result._tag === "Success") {
                if (result.value.warnings.length) {
                  setCreatedNumber(result.value.number);
                  setError(result.value.warnings.join(" "));
                } else onCreated(result.value.number);
              } else
                setError(
                  "Could not create the pull request. Check branches, reviewers, and repository access.",
                );
            } finally {
              setPending(false);
            }
          }}
        >
          <DialogPanel className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 text-sm">
                Source branch
                <Input
                  required
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
              </label>
              <label className="grid gap-2 text-sm">
                Target branch
                <Input
                  required
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                />
              </label>
            </div>
            <label className="grid gap-2 text-sm">
              Title
              <Input required value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm">
              Description
              <Textarea rows={6} value={body} onChange={(event) => setBody(event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm">
              Reviewer identifiers, separated by commas
              <Input value={reviewers} onChange={(event) => setReviewers(event.target.value)} />
            </label>
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={draft} onCheckedChange={setDraft} />
              Draft pull request
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !source.trim() || !target.trim() || !title.trim()}
            >
              {createdNumber !== null
                ? "Open created pull request"
                : pending
                  ? "Creating…"
                  : "Create pull request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
