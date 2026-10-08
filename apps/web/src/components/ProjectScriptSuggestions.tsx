import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { DiscoveredProjectScript, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Discovery is mounted only while adding an action, so idle threads never scan the workspace. */
export function ProjectScriptSuggestions({
  environmentId,
  cwd,
  onSelect,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  onSelect: (script: DiscoveredProjectScript) => void;
}) {
  const atom = projectEnvironment.discoverScripts({ environmentId, input: { cwd } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const data = Option.getOrNull(AsyncResult.value(result));
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const scripts =
    data?.scripts.filter((script) =>
      `${script.name} ${script.sourcePath} ${script.description ?? ""}`
        .toLowerCase()
        .includes(query),
    ) ?? [];
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="script-suggestions-search">Scripts from project files</Label>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={result.waiting}
          onClick={() => refresh()}
        >
          Refresh
        </Button>
      </div>
      <Input
        id="script-suggestions-search"
        placeholder="Search scripts or file paths…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Choose a script from package.json or a Taskfile to fill in this action.
      </p>
      {result.waiting && (
        <p className="text-xs text-muted-foreground" role="status">
          Finding project scripts…
        </p>
      )}
      {cause !== null && (
        <p className="text-xs text-destructive" role="alert">
          {cause instanceof Error ? cause.message : "Could not discover project scripts."}
        </p>
      )}
      {data && scripts.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {query ? "No matching scripts." : "No scripts found."}
        </p>
      )}
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {scripts.slice(0, 100).map((script) => (
          <button
            type="button"
            key={`${script.sourcePath}:${script.name}`}
            className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onSelect(script)}
          >
            <span className="block truncate text-sm font-medium">{script.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {script.sourcePath}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {script.command}
            </span>
          </button>
        ))}
      </div>
      {scripts.length > 100 && (
        <p className="text-xs text-muted-foreground">
          Showing 100 of {scripts.length} scripts. Search to narrow the list.
        </p>
      )}
      {data?.truncated && (
        <p className="text-xs text-muted-foreground">
          Discovery reached its limit. Some files or scripts may be missing.
        </p>
      )}
      {data && data.unreadablePaths.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Some files could not be read: {data.unreadablePaths.join(", ")}
        </p>
      )}
    </div>
  );
}
