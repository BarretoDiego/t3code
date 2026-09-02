import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  PROVIDER_TEMPLATE_PACKAGE_TYPE,
  ProviderTemplatePayload,
  type EnvironmentId,
  type MarketplaceCatalogEntry,
  type MarketplaceId,
  type MarketplaceInstallation,
  type MarketplaceTemplateInput,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const decodeProviderTemplate = Schema.decodeUnknownOption(ProviderTemplatePayload);

function mutationError(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag !== "Failure") return "The request did not complete.";
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : "The request failed.";
}

function ActionButton(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.destructive
          ? "rounded-full bg-destructive/10 px-4 py-2.5 active:opacity-70 disabled:opacity-40"
          : "rounded-full bg-primary px-4 py-2.5 active:opacity-70 disabled:opacity-40"
      }
    >
      <Text
        className={
          props.destructive
            ? "text-center text-sm font-t3-bold text-destructive"
            : "text-center text-sm font-t3-bold text-primary-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function FormField(props: {
  readonly input: MarketplaceTemplateInput;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
}) {
  const chooseOption = () => {
    Alert.alert(props.input.label, props.input.description, [
      ...props.input.options.map((option) => ({
        text: option.label,
        onPress: () => props.onChangeText(option.value),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  return (
    <View className="gap-1.5">
      <Text className="px-1 text-sm font-t3-medium text-foreground">
        {props.input.label}
        {props.input.required ? " *" : ""}
      </Text>
      {props.input.control === "select" ? (
        <Pressable
          onPress={chooseOption}
          className="min-h-12 justify-center rounded-[20px] bg-field px-4 active:opacity-70"
        >
          <Text
            className={props.value ? "text-base text-foreground" : "text-base text-placeholder"}
          >
            {props.input.options.find((option) => option.value === props.value)?.label ??
              props.input.placeholder ??
              "Select an option"}
          </Text>
        </Pressable>
      ) : (
        <TextInput
          className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base"
          value={props.value}
          onChangeText={props.onChangeText}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={props.input.control === "password"}
          textContentType={props.input.control === "password" ? "password" : "none"}
          placeholder={props.input.placeholder}
        />
      )}
      {props.input.description ? (
        <Text className="px-1 text-xs leading-normal text-foreground-muted">
          {props.input.description}
        </Text>
      ) : null}
    </View>
  );
}

function PackageDetailModal(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: MarketplaceCatalogEntry | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const insets = useSafeAreaInsets();
  const detailQuery = useEnvironmentQuery(
    props.entry
      ? serverEnvironment.marketplacePackage({
          environmentId: props.environmentId,
          input: { sourceId: props.entry.sourceId, packageId: props.entry.package.id },
        })
      : null,
  );
  const install = useAtomCommand(serverEnvironment.marketplaceInstall, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.marketplaceUpdate, { reportFailure: false });
  const uninstall = useAtomCommand(serverEnvironment.marketplaceUninstall, {
    reportFailure: false,
  });
  const detail = detailQuery.data;
  const template = detail
    ? Option.getOrNull(decodeProviderTemplate(detail.manifest.payload))
    : null;
  const packageKey = detail ? `${detail.source.id}/${detail.manifest.id}` : "";
  const [inputsByPackage, setInputsByPackage] = useState<Record<string, Record<string, string>>>(
    {},
  );
  const [providerIdByPackage, setProviderIdByPackage] = useState<Record<string, string>>({});
  const [displayNameByPackage, setDisplayNameByPackage] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const values = template
    ? Object.fromEntries(
        template.inputs.map((input) => [
          input.id,
          inputsByPackage[packageKey]?.[input.id] ?? input.default ?? "",
        ]),
      )
    : {};
  const providerId = providerIdByPackage[packageKey] ?? template?.suggestedInstanceId ?? "";
  const displayName = displayNameByPackage[packageKey] ?? template?.displayName ?? "";
  const validProviderId = /^[a-z][A-Za-z0-9_-]{0,63}$/.test(providerId);
  const missingInstallInput =
    template?.inputs.some((input) => input.required && !values[input.id]?.trim()) ?? true;
  const missingUpdateInput =
    template?.inputs.some(
      (input) =>
        input.required &&
        input.control !== "password" &&
        input.default === undefined &&
        !values[input.id]?.trim(),
    ) ?? true;

  const runMutation = async (
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
    successTitle: string,
  ) => {
    if (pending) return;
    setPending(true);
    const result = await action();
    setPending(false);
    if (result._tag === "Success") {
      Alert.alert(successTitle);
      detailQuery.refresh();
      props.onChanged();
      return;
    }
    Alert.alert("Marketplace request failed", mutationError(result));
  };

  const setInput = (id: string, value: string) => {
    setInputsByPackage((current) => ({
      ...current,
      [packageKey]: { ...current[packageKey], [id]: value },
    }));
  };

  return (
    <Modal
      visible={props.entry !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-sheet"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="flex-row items-center justify-between border-b border-separator px-5 py-4">
          <View className="min-w-0 flex-1 pr-3">
            <Text className="text-xl font-t3-bold" numberOfLines={1}>
              {detail?.manifest.name ?? props.entry?.package.name ?? "Package"}
            </Text>
            {detail ? (
              <Text className="text-sm text-foreground-muted">v{detail.manifest.version}</Text>
            ) : null}
          </View>
          <Pressable
            accessibilityLabel="Close package"
            accessibilityRole="button"
            onPress={props.onClose}
            className="size-10 items-center justify-center rounded-full bg-fill-secondary active:opacity-70"
          >
            <SymbolView name="xmark" size={16} tintColor="currentColor" weight="semibold" />
          </Pressable>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-5 px-5 pt-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 20) + 24 }}
        >
          {detailQuery.isPending && !detail ? <ActivityIndicator /> : null}
          {detailQuery.error ? (
            <Text className="rounded-2xl bg-destructive/10 p-4 text-destructive">
              {detailQuery.error}
            </Text>
          ) : null}
          {detail ? (
            <>
              <Text className="text-base leading-normal text-foreground-muted">
                {detail.manifest.description}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                <Text className="rounded-full bg-fill-secondary px-3 py-1.5 text-xs font-t3-medium">
                  {detail.manifest.type}
                </Text>
                {detail.manifest.publisher ? (
                  <Text className="rounded-full bg-fill-secondary px-3 py-1.5 text-xs font-t3-medium">
                    {detail.manifest.publisher}
                  </Text>
                ) : null}
              </View>
              {detail.manifest.permissions.length > 0 ? (
                <View className="gap-2 rounded-2xl bg-warning/10 p-4">
                  <Text className="text-sm font-t3-bold text-warning">Permissions requested</Text>
                  {detail.manifest.permissions.map((permission) => (
                    <Text key={permission} className="text-sm text-foreground-muted">
                      • {permission}
                    </Text>
                  ))}
                </View>
              ) : null}
              {detail.availability !== "available" ? (
                <Text className="rounded-2xl bg-fill-secondary p-4 text-foreground-muted">
                  {detail.availability === "unsupported-type"
                    ? "This server can browse this package type, but does not have an installer for it yet."
                    : "This package is not compatible with this server version or platform."}
                </Text>
              ) : null}
              {detail.manifest.type === PROVIDER_TEMPLATE_PACKAGE_TYPE && !template ? (
                <Text className="rounded-2xl bg-destructive/10 p-4 text-destructive">
                  The provider template payload is invalid.
                </Text>
              ) : null}
              {template ? (
                <View className="gap-4">
                  <View className="gap-1.5">
                    <Text className="px-1 text-sm font-t3-medium">Provider ID</Text>
                    <TextInput
                      className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base"
                      value={providerId}
                      onChangeText={(value) =>
                        setProviderIdByPackage((current) => ({ ...current, [packageKey]: value }))
                      }
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    {!validProviderId ? (
                      <Text className="px-1 text-xs text-destructive">
                        Start with a lowercase letter, then use letters, numbers, underscores, or
                        hyphens (64 characters max).
                      </Text>
                    ) : null}
                  </View>
                  <View className="gap-1.5">
                    <Text className="px-1 text-sm font-t3-medium">Display name</Text>
                    <TextInput
                      className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base"
                      value={displayName}
                      onChangeText={(value) =>
                        setDisplayNameByPackage((current) => ({ ...current, [packageKey]: value }))
                      }
                    />
                  </View>
                  {template.inputs.map((input) => (
                    <FormField
                      key={input.id}
                      input={input}
                      value={values[input.id] ?? ""}
                      onChangeText={(value) => setInput(input.id, value)}
                    />
                  ))}
                  <ActionButton
                    label={pending ? "Installing…" : "Install provider"}
                    disabled={
                      pending ||
                      detail.availability !== "available" ||
                      !validProviderId ||
                      missingInstallInput
                    }
                    onPress={() =>
                      void runMutation(
                        () =>
                          install({
                            environmentId: props.environmentId,
                            input: {
                              sourceId: detail.source.id,
                              packageId: detail.manifest.id,
                              instanceId: providerId as ProviderInstanceId,
                              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                              inputs: values,
                            },
                          }),
                        "Package installed",
                      )
                    }
                  />
                </View>
              ) : null}
              {detail.installations.length > 0 ? (
                <View className="gap-3 border-t border-separator pt-5">
                  <Text className="text-base font-t3-bold">Installed packages</Text>
                  {detail.installations.map((installation: MarketplaceInstallation) => (
                    <View key={installation.id} className="gap-3 rounded-2xl bg-card p-4">
                      <View>
                        <Text className="font-t3-medium">
                          {installation.target.type === "provider-instance"
                            ? installation.target.instanceId
                            : installation.target.reference}
                        </Text>
                        <Text className="text-sm text-foreground-muted">
                          v{installation.installedVersion}
                        </Text>
                      </View>
                      <View className="flex-row gap-2">
                        {props.entry?.updateAvailable ? (
                          <View className="flex-1">
                            <ActionButton
                              label="Update"
                              disabled={pending || missingUpdateInput}
                              onPress={() =>
                                void runMutation(
                                  () =>
                                    update({
                                      environmentId: props.environmentId,
                                      input: {
                                        installationId: installation.id,
                                        inputs: Object.fromEntries(
                                          Object.entries(values).filter(
                                            ([, value]) => value !== "",
                                          ),
                                        ),
                                      },
                                    }),
                                  "Package updated",
                                )
                              }
                            />
                          </View>
                        ) : null}
                        <View className="flex-1">
                          <ActionButton
                            label="Uninstall"
                            destructive
                            disabled={pending}
                            onPress={() =>
                              Alert.alert(
                                "Uninstall package?",
                                "The provider instance and package-managed files will be removed.",
                                [
                                  { text: "Cancel", style: "cancel" },
                                  {
                                    text: "Uninstall",
                                    style: "destructive",
                                    onPress: () =>
                                      void runMutation(
                                        () =>
                                          uninstall({
                                            environmentId: props.environmentId,
                                            input: { installationId: installation.id },
                                          }),
                                        "Package uninstalled",
                                      ),
                                  },
                                ],
                              )
                            }
                          />
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SettingsMarketplaceRouteScreen() {
  const insets = useSafeAreaInsets();
  const iconColor = useUniwindTheme()["--color-icon"];
  const { environments, isReady } = useEnvironments();
  const [requestedEnvironmentId, setRequestedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find(({ environmentId: id }) => id === requestedEnvironmentId)?.environmentId ??
    environments[0]?.environmentId ??
    null;
  const marketplace = useEnvironmentQuery(
    environmentId ? serverEnvironment.marketplace({ environmentId, input: {} }) : null,
  );
  const addSource = useAtomCommand(serverEnvironment.marketplaceAddSource, {
    reportFailure: false,
  });
  const removeSource = useAtomCommand(serverEnvironment.marketplaceRemoveSource, {
    reportFailure: false,
  });
  const [sourceUrl, setSourceUrl] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<MarketplaceCatalogEntry | null>(null);
  const [pendingSource, setPendingSource] = useState(false);
  const snapshot = marketplace.data;
  const packages = useMemo(
    () =>
      [...(snapshot?.packages ?? [])].sort((a, b) => a.package.name.localeCompare(b.package.name)),
    [snapshot?.packages],
  );

  const handleAddSource = async () => {
    if (!environmentId || !sourceUrl.trim() || pendingSource) return;
    setPendingSource(true);
    const result = await addSource({ environmentId, input: { url: sourceUrl.trim() } });
    setPendingSource(false);
    if (result._tag === "Success") {
      setSourceUrl("");
      marketplace.refresh();
      return;
    }
    Alert.alert("Could not add source", mutationError(result));
  };

  const handleRemoveSource = (sourceId: MarketplaceId) => {
    if (!environmentId || pendingSource) return;
    Alert.alert(
      "Remove marketplace source?",
      "Installed packages from this source must be removed first.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setPendingSource(true);
            void removeSource({ environmentId, input: { sourceId } }).then((result) => {
              setPendingSource(false);
              if (result._tag === "Success") {
                marketplace.refresh();
                return;
              }
              Alert.alert("Could not remove source", mutationError(result));
            });
          },
        },
      ],
    );
  };

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length > 1 ? (
          <SettingsSection title="Environment" card>
            {environments.map((environment) => (
              <Pressable
                key={environment.environmentId}
                onPress={() => setRequestedEnvironmentId(environment.environmentId)}
                className="flex-row items-center gap-3 border-b border-separator p-4 last:border-b-0 active:opacity-70"
              >
                <SymbolView name="desktopcomputer" size={20} tintColor={iconColor} />
                <Text className="min-w-0 flex-1 text-base" numberOfLines={1}>
                  {environment.label}
                </Text>
                {environment.environmentId === environmentId ? (
                  <SymbolView name="checkmark" size={16} tintColor={iconColor} weight="semibold" />
                ) : null}
              </Pressable>
            ))}
          </SettingsSection>
        ) : null}

        {!environmentId ? (
          <View className="items-center gap-2 rounded-2xl bg-card px-5 py-8">
            <Text className="text-lg font-t3-bold">
              {isReady ? "No connected environments" : "Loading environments"}
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              Connect an environment before using the marketplace.
            </Text>
          </View>
        ) : null}

        <SettingsSection title="Repositories" card>
          <View className="gap-3 p-4">
            <TextInput
              className="h-12 min-h-12 rounded-[20px] px-4 py-0 text-base"
              value={sourceUrl}
              onChangeText={setSourceUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://github.com/owner/marketplace"
              returnKeyType="done"
              onSubmitEditing={() => void handleAddSource()}
            />
            <ActionButton
              label={pendingSource ? "Adding…" : "Add repository"}
              disabled={!environmentId || !sourceUrl.trim() || pendingSource}
              onPress={() => void handleAddSource()}
            />
          </View>
          {snapshot?.sources.map((source) => (
            <Pressable
              key={source.id}
              disabled={!source.removable || pendingSource}
              onLongPress={source.removable ? () => handleRemoveSource(source.id) : undefined}
              className="flex-row items-center gap-3 border-t border-separator p-4 active:opacity-70"
            >
              <SymbolView name="shippingbox" size={20} tintColor={iconColor} />
              <View className="min-w-0 flex-1">
                <Text className="font-t3-medium" numberOfLines={1}>
                  {source.name}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {source.official ? "Official" : source.url}
                </Text>
              </View>
              {source.removable ? (
                <Pressable
                  accessibilityLabel={`Remove ${source.name}`}
                  onPress={() => handleRemoveSource(source.id)}
                  className="size-9 items-center justify-center"
                >
                  <SymbolView name="trash" size={16} tintColor={iconColor} />
                </Pressable>
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>

        {marketplace.error ? (
          <Text className="rounded-2xl bg-destructive/10 p-4 text-destructive">
            {marketplace.error}
          </Text>
        ) : null}
        {snapshot?.sourceErrors.map((error) => (
          <Text key={error.sourceId} className="rounded-2xl bg-destructive/10 p-4 text-destructive">
            {error.sourceName}: {error.detail}
          </Text>
        ))}

        <SettingsSection title="Packages" card>
          {marketplace.isPending && !snapshot ? (
            <View className="p-8">
              <ActivityIndicator />
            </View>
          ) : packages.length === 0 ? (
            <Text className="p-5 text-center text-foreground-muted">No packages available.</Text>
          ) : (
            packages.map((entry) => (
              <Pressable
                key={`${entry.sourceId}/${entry.package.id}`}
                onPress={() => setSelectedEntry(entry)}
                className="flex-row items-center gap-4 border-b border-separator p-4 last:border-b-0 active:opacity-70"
              >
                <View className="size-10 items-center justify-center rounded-xl bg-fill-secondary">
                  <SymbolView name="shippingbox" size={20} tintColor={iconColor} />
                </View>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="font-t3-medium" numberOfLines={1}>
                    {entry.package.name}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                    {entry.package.type} · {entry.sourceName}
                  </Text>
                </View>
                <Text className="text-xs text-foreground-muted">
                  {entry.updateAvailable
                    ? "Update"
                    : entry.installedVersions.length > 0
                      ? "Installed"
                      : `v${entry.package.version}`}
                </Text>
              </Pressable>
            ))
          )}
        </SettingsSection>
      </ScrollView>

      {environmentId ? (
        <PackageDetailModal
          environmentId={environmentId}
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onChanged={marketplace.refresh}
        />
      ) : null}
    </View>
  );
}
