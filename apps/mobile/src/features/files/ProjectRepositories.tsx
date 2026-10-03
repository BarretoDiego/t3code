import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { useState } from "react";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";

export function ProjectRepositories(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [addedPath, setAddedPath] = useState<string | null>(null);
  const repositories = useEnvironmentQuery(
    open
      ? projectEnvironment.listEntries({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, repositoriesOnly: true },
        })
      : null,
  );
  return (
    <View className="border-b border-border px-3 py-2">
      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="flex-1 py-2"
        >
          <Text className="text-xs font-t3-medium text-muted-foreground">
            {open ? "▾" : "▸"} Repositories
            {repositories.data ? ` (${repositories.data.entries.length})` : ""}
          </Text>
        </Pressable>
        {open ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh repositories"
            onPress={repositories.refresh}
            className="px-2 py-2"
          >
            <Text className="text-xs text-primary">Refresh</Text>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <>
          {repositories.isPending ? (
            <Text accessibilityRole="alert" className="py-2 text-xs text-muted-foreground">
              Finding repositories…
            </Text>
          ) : null}
          {repositories.error ? (
            <Text className="py-2 text-xs text-destructive">{repositories.error}</Text>
          ) : null}
          <FlatList
            style={{ maxHeight: 240 }}
            data={repositories.data?.entries ?? []}
            keyExtractor={(entry) => entry.path}
            ListEmptyComponent={
              !repositories.isPending && !repositories.error ? (
                <Text className="py-2 text-xs text-muted-foreground">
                  No Git repositories found.
                </Text>
              ) : undefined
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Mention ${item.path} in chat`}
                accessibilityState={{ disabled: props.threadId === null }}
                disabled={props.threadId === null}
                className="flex-row items-center justify-between py-2"
                onPress={() => {
                  if (props.threadId === null) return;
                  const key = scopedThreadKey(props.environmentId, props.threadId);
                  const draft = getComposerDraftSnapshot(key);
                  appendComposerDraftText(
                    key,
                    `${draft.text && !/\s$/.test(draft.text) ? " " : ""}${serializeComposerFileLink(item.path)} `,
                  );
                  setAddedPath(item.path);
                }}
              >
                <View className="flex-1">
                  <Text numberOfLines={1} className="text-sm text-foreground">
                    {item.path === "." ? props.projectName : item.path.split("/").at(-1)}
                  </Text>
                  <Text numberOfLines={1} className="text-xs text-muted-foreground">
                    {item.path}
                  </Text>
                </View>
                <Text className="px-2 text-sm text-primary">@</Text>
              </Pressable>
            )}
          />
          {addedPath ? (
            <Text accessibilityRole="alert" className="py-1 text-xs text-muted-foreground">
              Added {addedPath} to chat.
            </Text>
          ) : null}
          {repositories.data?.truncated ? (
            <Text className="py-1 text-xs text-muted-foreground">
              Some folders could not be scanned. Open a smaller project folder to see more
              repositories.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
