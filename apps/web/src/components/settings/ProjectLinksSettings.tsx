import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  derivePhysicalProjectKey,
  planProjectGroupLink,
  planProjectGroupLinkId,
  projectLinkConfiguration,
  selectProjectLinkCandidates,
  selectProjectLinkPeers,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { ProjectLinkKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useMemo, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { randomUUID } from "../../lib/utils";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const isProjectLinkKey = Schema.is(ProjectLinkKey);

const projectRefKey = (member: {
  environmentId: SidebarProjectGroupMember["environmentId"];
  id: SidebarProjectGroupMember["id"];
}) => scopedProjectKey(scopeProjectRef(member.environmentId, member.id));

export function ProjectLinksSettings({
  group,
  updateMembers,
}: {
  group: SidebarProjectSnapshot;
  updateMembers: (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    input: { linkKey: string | null },
    failureTitle: string,
  ) => Promise<AtomCommandResult<void, unknown>>;
}) {
  const projects = useProjects();
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );
  const allMembers = useMemo(
    () =>
      projects.map((project) => ({
        ...project,
        physicalProjectKey: derivePhysicalProjectKey(project),
        environmentLabel:
          environmentById.get(project.environmentId)?.label ?? project.environmentId,
      })),
    [projects, environmentById],
  );
  const candidates = useMemo(
    () => selectProjectLinkCandidates({ projects: allMembers, members: group.memberProjects }),
    [allMembers, group.memberProjects],
  );
  const [query, setQuery] = useState("");
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: "Copied project links" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy project links",
        description: error.message,
      }),
  });
  const target = candidates.find((candidate) => projectRefKey(candidate) === targetKey);
  const visibleCandidates = candidates.filter((candidate) =>
    `${candidate.title} ${candidate.environmentLabel} ${candidate.workspaceRoot} ${candidate.linkKey ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const connected = (member: SidebarProjectGroupMember) => {
    const environment = environmentById.get(member.environmentId);
    return environment?.connection.phase === "connected" && environment.serverConfig !== null;
  };
  const write = async (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    linkKey: string | null,
  ) => {
    if (busyRef.current) return;
    if (linkKey !== null && !isProjectLinkKey(linkKey)) {
      toastManager.add({ type: "error", title: "Link ID must contain 1–128 characters" });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      return await updateMembers(members, { linkKey }, "Failed to update project links");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const applyPlan = (plan: ReturnType<typeof planProjectGroupLink>) => {
    const refs = new Set(plan.updates.map((ref) => scopedProjectKey(ref)));
    return write(
      allMembers.filter((member) => refs.has(projectRefKey(member))),
      plan.linkKey,
    );
  };
  const link = async () => {
    if (!target) return;
    const targetGroup = groups.find((candidate) =>
      candidate.memberProjectRefs.some((ref) => scopedProjectKey(ref) === projectRefKey(target)),
    );
    if (!targetGroup) return;
    const result = await applyPlan(
      planProjectGroupLink({
        source: { key: group.projectKey, members: group.memberProjects },
        target: { key: targetGroup.projectKey, members: targetGroup.memberProjects },
        makeLinkKey: randomUUID,
      }),
    );
    if (result?._tag === "Success") setTargetKey(null);
  };

  return (
    <SettingsSection
      title="Project links"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            copyToClipboard(JSON.stringify(projectLinkConfiguration(projects), null, 2))
          }
        >
          Copy configuration
        </Button>
      }
    >
      <SettingsRow
        title="Link IDs"
        description="Projects with the same Link ID are linked across environments. Links do not copy files. Copy the configuration to share it with an agent. Removing an ID restores automatic Git grouping. Keep-separate grouping still shows each checkout individually."
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !group.memberProjects.some((member) => !member.linkKey) ||
                !group.memberProjects.every(connected)
              }
              onClick={() =>
                void applyPlan(
                  planProjectGroupLinkId({
                    group: { key: group.projectKey, members: group.memberProjects },
                    makeLinkKey: randomUUID,
                  }),
                )
              }
            >
              Generate missing IDs
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !group.memberProjects.some((member) => member.linkKey) ||
                !group.memberProjects.every(connected)
              }
              onClick={() =>
                void write(
                  group.memberProjects.filter((member) => member.linkKey),
                  null,
                )
              }
            >
              Remove links
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Link to another project"
        description="Choose a checkout from any known environment. The list includes individual projects regardless of sidebar grouping. Connect an offline environment before linking."
        control={
          <div className="flex w-full flex-col gap-2 sm:w-80">
            <Input
              size="sm"
              aria-label="Search projects to link"
              placeholder="Search by project, environment or path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={targetKey}
                  onValueChange={(value) => setTargetKey(value)}
                  disabled={busy || candidates.length === 0}
                >
                  <SelectTrigger size="sm" aria-label="Project to link">
                    <SelectValue placeholder="Choose a project">
                      {target
                        ? `${target.title} · ${target.environmentLabel} · ${target.workspaceRoot}`
                        : "Choose a project"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {visibleCandidates.map((candidate) => (
                      <SelectItem key={projectRefKey(candidate)} value={projectRefKey(candidate)}>
                        {candidate.title} · {candidate.environmentLabel} · {candidate.workspaceRoot}
                        {connected(candidate) ? "" : " (offline)"}
                      </SelectItem>
                    ))}
                    {visibleCandidates.length === 0 ? (
                      <div className="p-3 text-sm text-muted-foreground">No matching projects.</div>
                    ) : null}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy || !target || !connected(target) || !group.memberProjects.every(connected)
                }
                onClick={() => void link()}
              >
                Link
              </Button>
            </div>
          </div>
        }
      />
      {group.memberProjects.map((member) => (
        <ProjectLinkRow
          key={`${projectRefKey(member)}:${member.linkKey ?? ""}`}
          member={member}
          projects={allMembers}
          busy={busy || !connected(member)}
          write={write}
          copy={copyToClipboard}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectLinkRow({
  member,
  projects,
  busy,
  write,
  copy,
}: {
  member: SidebarProjectGroupMember;
  projects: ReadonlyArray<SidebarProjectGroupMember>;
  busy: boolean;
  write: (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    key: string | null,
  ) => Promise<AtomCommandResult<void, unknown> | undefined>;
  copy: (value: string) => void;
}) {
  const [draft, setDraft] = useState(member.linkKey ?? "");
  const next = draft.trim();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const peers = selectProjectLinkPeers({ project: member, projects, settings });
  return (
    <SettingsRow
      title={`${member.title} · ${member.environmentLabel ?? member.environmentId}`}
      description={
        <span className="break-all">
          {member.workspaceRoot}
          <br />
          {member.linkKey
            ? `Link ID: ${member.linkKey}`
            : `Automatic identity: ${member.repositoryIdentity?.canonicalKey ?? "None"}`}
          {peers.map((peer) => (
            <span key={projectRefKey(peer)} className="block">
              Linked: {peer.title} · {peer.environmentLabel} · {peer.workspaceRoot}
            </span>
          ))}
        </span>
      }
      control={
        <div className="flex w-full flex-col gap-2 sm:w-80">
          <Input
            size="sm"
            aria-label={`Link ID for ${member.workspaceRoot}`}
            placeholder="Paste a Link ID"
            maxLength={128}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !next || next === member.linkKey || !isProjectLinkKey(next)}
              onClick={() => void write([member], next)}
            >
              Save ID
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || Boolean(member.linkKey)}
              onClick={() => void write([member], `link:${randomUUID()}`)}
            >
              Generate ID
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!member.linkKey}
              onClick={() => member.linkKey && copy(member.linkKey)}
            >
              Copy ID
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !member.linkKey}
              onClick={() => void write([member], null)}
            >
              Unlink
            </Button>
          </div>
        </div>
      }
    />
  );
}
