import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  planProjectGroupLink,
  planProjectGroupLinkId,
  projectLinkConfiguration,
  selectProjectLinkCandidates,
  selectProjectLinkPeers,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProjectLinkKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { ControlPillMenu } from "../../../components/ControlPillMenu";
import { uuidv4 } from "../../../lib/uuid";
import { useProjects } from "../../../state/entities";
import { useEnvironments } from "../../../state/environments";
import { useMobileProjectGroupingSettings } from "../../../state/project-grouping";
import { projectEnvironment } from "../../../state/projects";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";
import { SettingsSection } from "./SettingsSection";

const isProjectLinkKey = Schema.is(ProjectLinkKey);

const refKey = (project: EnvironmentProject) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

export function ProjectLinksSection({ members }: { members: ReadonlyArray<EnvironmentProject> }) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project links update",
    reportFailure: true,
  });
  const [query, setQuery] = useState("");
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const label = (project: EnvironmentProject) =>
    environments.find((entry) => entry.environmentId === project.environmentId)?.label ??
    project.environmentId;
  const connected = (project: EnvironmentProject) =>
    environments.some(
      (entry) =>
        entry.environmentId === project.environmentId &&
        entry.connection.phase === "connected" &&
        entry.serverConfig !== null,
    );
  const candidates = selectProjectLinkCandidates({ projects, members });
  const visibleCandidates = candidates.filter((project) =>
    `${project.title} ${label(project)} ${project.workspaceRoot} ${project.linkKey ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const target = candidates.find((project) => refKey(project) === targetKey);
  const copy = async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
    } catch {
      Alert.alert("Could not copy project links", "Try again or select the Link ID to copy it.");
    }
  };
  const write = async (selected: ReadonlyArray<EnvironmentProject>, linkKey: string | null) => {
    if (busyRef.current) return false;
    if (linkKey !== null && !isProjectLinkKey(linkKey)) {
      Alert.alert("Invalid Link ID", "Enter 1–128 characters.");
      return false;
    }
    const unavailable = selected.find((member) => !connected(member));
    if (unavailable) {
      Alert.alert("Environment offline", `Connect ${label(unavailable)} and try again.`);
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      for (const member of selected) {
        const result = await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, linkKey },
        });
        if (result._tag !== "Success") return false;
      }
      return true;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const applyPlan = (plan: ReturnType<typeof planProjectGroupLink>) => {
    const refs = new Set(plan.updates.map((ref) => scopedProjectKey(ref)));
    return write(
      projects.filter((project) => refs.has(refKey(project))),
      plan.linkKey,
    );
  };
  const link = async () => {
    if (!group || !target) return;
    const targetGroup = projectGroups.find((entry) =>
      entry.memberProjectRefs.some((ref) => scopedProjectKey(ref) === refKey(target)),
    );
    if (!targetGroup) return;
    if (
      await applyPlan(
        planProjectGroupLink({
          source: { key: group.key, members },
          target: {
            key: targetGroup.key,
            members: targetGroup.members.map((entry) => entry.project),
          },
          makeLinkKey: uuidv4,
        }),
      )
    )
      setTargetKey(null);
  };

  return (
    <SettingsSection title="Project links">
      <View className="gap-3 p-4">
        <Text className="text-sm leading-normal text-foreground-muted">
          Projects with the same Link ID are linked across environments. Links do not copy files.
          Removing an ID restores automatic Git grouping. Keep-separate grouping still shows each
          checkout individually.
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <LinkAction
            label="Generate missing IDs"
            disabled={busy || !group || !members.some((member) => !member.linkKey)}
            onPress={() =>
              group &&
              void applyPlan(
                planProjectGroupLinkId({ group: { key: group.key, members }, makeLinkKey: uuidv4 }),
              )
            }
          />
          <LinkAction
            label="Remove links"
            disabled={busy || !members.some((member) => member.linkKey)}
            onPress={() =>
              void write(
                members.filter((member) => member.linkKey),
                null,
              )
            }
          />
          <LinkAction
            label="Copy configuration"
            onPress={() => void copy(JSON.stringify(projectLinkConfiguration(projects), null, 2))}
          />
        </View>
        <AppTextInput
          accessibilityLabel="Search projects to link"
          placeholder="Search by project, environment or path"
          value={query}
          onChangeText={setQuery}
          className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
        />
        <ControlPillMenu
          accessibilityLabel="Project to link"
          title="Project to link"
          actions={visibleCandidates.map((project) => ({
            id: refKey(project),
            title: `${project.title} · ${label(project)}`,
            subtitle: `${project.workspaceRoot}${connected(project) ? "" : " (offline)"}`,
            state: targetKey === refKey(project) ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => setTargetKey(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            disabled={busy || visibleCandidates.length === 0}
            className="rounded-xl bg-subtle-strong px-3 py-3 disabled:opacity-40"
          >
            <Text className="text-sm text-foreground">
              {target
                ? `${target.title} · ${label(target)} · ${target.workspaceRoot}`
                : visibleCandidates.length === 0
                  ? "No matching projects"
                  : "Choose a project"}
            </Text>
          </Pressable>
        </ControlPillMenu>
        <LinkAction
          label="Link project"
          disabled={busy || !target || !connected(target)}
          onPress={() => void link()}
        />
      </View>
      {members.map((member) => (
        <ProjectLinkRow
          key={`${refKey(member)}:${member.linkKey ?? ""}`}
          member={member}
          projects={projects}
          label={label}
          busy={busy || !connected(member)}
          write={write}
          copy={copy}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectLinkRow({
  member,
  projects,
  label,
  busy,
  write,
  copy,
}: {
  member: EnvironmentProject;
  projects: ReadonlyArray<EnvironmentProject>;
  label: (project: EnvironmentProject) => string;
  busy: boolean;
  write: (members: ReadonlyArray<EnvironmentProject>, key: string | null) => Promise<boolean>;
  copy: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(member.linkKey ?? "");
  const next = draft.trim();
  const settings = useMobileProjectGroupingSettings();
  const peers = selectProjectLinkPeers({ project: member, projects, settings });
  return (
    <View className="gap-3 border-t border-border-subtle p-4">
      <Text className="text-base text-foreground">
        {member.title} · {label(member)}
      </Text>
      <Text className="text-sm text-foreground-muted" selectable>
        {member.workspaceRoot}
      </Text>
      <Text className="text-sm text-foreground-muted" selectable>
        {member.linkKey
          ? `Link ID: ${member.linkKey}`
          : `Automatic identity: ${member.repositoryIdentity?.canonicalKey ?? "None"}`}
      </Text>
      {peers.map((peer) => (
        <Text key={refKey(peer)} className="text-sm text-foreground-muted">
          Linked: {peer.title} · {label(peer)} · {peer.workspaceRoot}
        </Text>
      ))}
      <AppTextInput
        accessibilityLabel={`Link ID for ${member.workspaceRoot}`}
        placeholder="Paste a Link ID"
        value={draft}
        onChangeText={setDraft}
        maxLength={128}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        className="min-h-11 rounded-xl border-continuous bg-card px-3 text-base text-foreground"
      />
      <View className="flex-row flex-wrap gap-2">
        <LinkAction
          label="Save ID"
          disabled={busy || !next || next === member.linkKey || !isProjectLinkKey(next)}
          onPress={() => void write([member], next)}
        />
        <LinkAction
          label="Generate ID"
          disabled={busy || Boolean(member.linkKey)}
          onPress={() => void write([member], `link:${uuidv4()}`)}
        />
        <LinkAction
          label="Copy ID"
          disabled={!member.linkKey}
          onPress={() => member.linkKey && void copy(member.linkKey)}
        />
        <LinkAction
          label="Unlink"
          disabled={busy || !member.linkKey}
          onPress={() => void write([member], null)}
        />
      </View>
    </View>
  );
}

function LinkAction(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="rounded-full bg-subtle-strong px-4 py-2 active:opacity-70 disabled:opacity-40"
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}
