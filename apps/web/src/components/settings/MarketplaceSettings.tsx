import { useEffect, useMemo, useRef, useState } from "react";
import { PackageOpenIcon, PlusIcon, RefreshCwIcon, StoreIcon, Trash2Icon } from "lucide-react";
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
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { groupMarketplacePackagesByType } from "./MarketplaceSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const decodeProviderTemplate = Schema.decodeUnknownOption(ProviderTemplatePayload);

function errorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : "The request failed.";
}

function packageTypeLabel(type: string): string {
  return type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function PackageStatus({ entry }: { readonly entry: MarketplaceCatalogEntry }) {
  if (entry.updateAvailable) return <Badge variant="warning">Update</Badge>;
  if (entry.installedVersions.length > 0) return <Badge variant="success">Installed</Badge>;
  if (entry.availability === "unsupported-type") {
    return <Badge variant="secondary">Not installable yet</Badge>;
  }
  if (entry.availability === "incompatible") return <Badge variant="warning">Incompatible</Badge>;
  return <Badge variant="outline">{entry.package.version}</Badge>;
}

function PackageCard({
  entry,
  onOpen,
}: {
  readonly entry: MarketplaceCatalogEntry;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex min-h-36 flex-col rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-border hover:bg-muted/25"
      onClick={onOpen}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/8 text-primary">
          <PackageOpenIcon className="size-4" aria-hidden />
        </span>
        <PackageStatus entry={entry} />
      </div>
      <div className="mt-3 min-w-0">
        <div className="truncate text-sm font-semibold">{entry.package.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {packageTypeLabel(entry.package.type)} · {entry.sourceName}
        </div>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground/85">
        {entry.package.description}
      </p>
    </button>
  );
}

function TemplateField({
  input,
  value,
  onChange,
}: {
  readonly input: MarketplaceTemplateInput;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`marketplace-input-${input.id}`}>
        {input.label}
        {input.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {input.control === "select" ? (
        <select
          id={`marketplace-input-${input.id}`}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Select an option</option>
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={`marketplace-input-${input.id}`}
          type={input.control === "password" ? "password" : "text"}
          autoComplete={input.control === "password" ? "off" : undefined}
          placeholder={input.placeholder}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      {input.description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{input.description}</p>
      ) : null}
    </div>
  );
}

function PackageDialog({
  environmentId,
  selected,
  open,
  onOpenChange,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly selected: MarketplaceCatalogEntry | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => void;
}) {
  const packageQuery = useEnvironmentQuery(
    selected
      ? serverEnvironment.marketplacePackage({
          environmentId,
          input: { sourceId: selected.sourceId, packageId: selected.package.id },
        })
      : null,
  );
  const installPackage = useAtomCommand(serverEnvironment.marketplaceInstall, {
    reportFailure: false,
  });
  const updatePackage = useAtomCommand(serverEnvironment.marketplaceUpdate, {
    reportFailure: false,
  });
  const uninstallPackage = useAtomCommand(serverEnvironment.marketplaceUninstall, {
    reportFailure: false,
  });
  const setAutoUpdate = useAtomCommand(serverEnvironment.marketplaceSetAutoUpdate, {
    reportFailure: false,
  });

  const toggleAutoUpdate = async (installation: MarketplaceInstallation, enabled: boolean) => {
    if (pendingAction) return;
    setPendingAction(`auto-update:${installation.id}`);
    const result = await setAutoUpdate({
      environmentId,
      input: { installationId: installation.id, autoUpdate: enabled },
    });
    setPendingAction(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: enabled ? "Automatic updates enabled" : "Automatic updates disabled",
      });
      packageQuery.refresh();
      onChanged();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Marketplace request failed",
      description: errorMessage(result),
    });
  };
  const detail = packageQuery.data;
  const template = detail
    ? Option.getOrNull(decodeProviderTemplate(detail.manifest.payload))
    : null;
  const [inputsByPackage, setInputsByPackage] = useState<
    Record<string, Readonly<Record<string, string>>>
  >({});
  const [instanceIdByPackage, setInstanceIdByPackage] = useState<Record<string, string>>({});
  const [displayNameByPackage, setDisplayNameByPackage] = useState<Record<string, string>>({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const packageKey = detail ? `${detail.source.id}/${detail.manifest.id}` : "";
  const formInputs = inputsByPackage[packageKey] ?? {};
  const instanceId =
    instanceIdByPackage[packageKey] ?? (template ? template.suggestedInstanceId : "");
  const displayName = displayNameByPackage[packageKey] ?? (template ? template.displayName : "");

  const resolvedInputs = template
    ? Object.fromEntries(
        template.inputs.map((input) => [input.id, formInputs[input.id] ?? input.default ?? ""]),
      )
    : {};
  const validInstanceId = /^[a-z][A-Za-z0-9_-]{0,63}$/.test(instanceId);
  const missingRequired =
    template?.inputs.some((input) => input.required && !resolvedInputs[input.id]?.trim()) ?? true;
  const missingRequiredForUpdate =
    template?.inputs.some(
      (input) =>
        input.required &&
        input.control !== "password" &&
        input.default === undefined &&
        !resolvedInputs[input.id]?.trim(),
    ) ?? true;
  const canInstall =
    detail?.availability === "available" &&
    template !== null &&
    validInstanceId &&
    !missingRequired;

  const mutate = async (
    label: string,
    action: () => ReturnType<typeof installPackage>,
    successMessage: string,
  ) => {
    if (pendingAction) return;
    setPendingAction(label);
    const result = await action();
    setPendingAction(null);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: successMessage });
      packageQuery.refresh();
      onChanged();
      return;
    }
    toastManager.add({
      type: "error",
      title: "Marketplace request failed",
      description: errorMessage(result),
    });
  };

  const updateInput = (id: string, value: string) => {
    setInputsByPackage((current) => ({
      ...current,
      [packageKey]: { ...current[packageKey], [id]: value },
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{detail?.manifest.name ?? selected?.package.name ?? "Package"}</DialogTitle>
          <DialogDescription>
            {detail?.manifest.description ??
              selected?.package.description ??
              "Loading package details."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {packageQuery.error ? (
            <div className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground">
              {packageQuery.error}
            </div>
          ) : null}
          {!detail && packageQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Loading package manifest…</p>
          ) : null}
          {detail ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{packageTypeLabel(detail.manifest.type)}</Badge>
                <Badge variant="outline">v{detail.manifest.version}</Badge>
                {detail.manifest.publisher ? (
                  <Badge variant="secondary">{detail.manifest.publisher}</Badge>
                ) : null}
              </div>
              {detail.manifest.permissions.length > 0 ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Permissions requested</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.manifest.permissions.map((permission) => (
                      <Badge key={permission} variant="warning">
                        {permission}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {detail.availability === "unsupported-type" ? (
                <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                  This package type can be browsed, but this T3 Code server does not have an
                  installer for it yet.
                </p>
              ) : null}
              {detail.availability === "incompatible" ? (
                <p className="rounded-lg bg-warning/8 p-3 text-sm text-warning-foreground">
                  This package is not compatible with this server version or platform.
                </p>
              ) : null}
              {detail.manifest.type === PROVIDER_TEMPLATE_PACKAGE_TYPE && !template ? (
                <p className="rounded-lg bg-destructive/8 p-3 text-sm text-destructive-foreground">
                  The provider template payload is invalid.
                </p>
              ) : null}
              {template ? (
                <div className="space-y-4 border-t border-border/60 pt-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="marketplace-instance-id">Provider ID</Label>
                      <Input
                        id="marketplace-instance-id"
                        value={instanceId}
                        onChange={(event) =>
                          setInstanceIdByPackage((current) => ({
                            ...current,
                            [packageKey]: event.currentTarget.value,
                          }))
                        }
                        aria-invalid={!validInstanceId}
                      />
                      {!validInstanceId ? (
                        <p className="text-xs text-destructive-foreground">
                          Start with a lowercase letter, then use letters, numbers, underscores, or
                          hyphens (64 characters max).
                        </p>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="marketplace-display-name">Display name</Label>
                      <Input
                        id="marketplace-display-name"
                        value={displayName}
                        onChange={(event) =>
                          setDisplayNameByPackage((current) => ({
                            ...current,
                            [packageKey]: event.currentTarget.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                  {template.inputs.map((input) => (
                    <TemplateField
                      key={input.id}
                      input={input}
                      value={resolvedInputs[input.id] ?? ""}
                      onChange={(value) => updateInput(input.id, value)}
                    />
                  ))}
                </div>
              ) : null}
              {detail.installations.length > 0 ? (
                <div className="space-y-2 border-t border-border/60 pt-4">
                  <h3 className="text-sm font-medium">Installed from this package</h3>
                  {detail.installations.map((installation: MarketplaceInstallation) => (
                    <div
                      key={installation.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/45 p-3"
                    >
                      <div>
                        <div className="text-sm font-medium">
                          {installation.target.type === "provider-instance"
                            ? installation.target.instanceId
                            : installation.target.reference}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          v{installation.installedVersion}
                        </div>
                        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch
                            checked={installation.autoUpdate}
                            disabled={pendingAction !== null}
                            onCheckedChange={(checked) =>
                              void toggleAutoUpdate(installation, Boolean(checked))
                            }
                            aria-label={`Automatically update ${installation.packageName}`}
                          />
                          Auto-update
                        </label>
                      </div>
                      <div className="flex gap-2">
                        {selected?.updateAvailable ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingAction !== null || missingRequiredForUpdate}
                            onClick={() =>
                              void mutate(
                                `update:${installation.id}`,
                                () =>
                                  updatePackage({
                                    environmentId,
                                    input: {
                                      installationId: installation.id,
                                      inputs: Object.fromEntries(
                                        Object.entries(resolvedInputs).filter(
                                          ([, value]) => value !== "",
                                        ),
                                      ),
                                    },
                                  }),
                                "Package updated",
                              )
                            }
                          >
                            Update
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pendingAction !== null}
                          onClick={() =>
                            void mutate(
                              `uninstall:${installation.id}`,
                              () =>
                                uninstallPackage({
                                  environmentId,
                                  input: { installationId: installation.id },
                                }),
                              "Package uninstalled",
                            )
                          }
                        >
                          <Trash2Icon className="size-3.5" />
                          Uninstall
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {detail && template ? (
            <Button
              disabled={!canInstall || pendingAction !== null}
              onClick={() =>
                void mutate(
                  "install",
                  () =>
                    installPackage({
                      environmentId,
                      input: {
                        sourceId: detail.source.id,
                        packageId: detail.manifest.id,
                        instanceId: instanceId as ProviderInstanceId,
                        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                        inputs: resolvedInputs,
                      },
                    }),
                  "Package installed",
                )
              }
            >
              Install provider
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function MarketplaceSettings() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [requestedEnvironmentId, setRequestedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find(({ environmentId: id }) => id === requestedEnvironmentId)?.environmentId ??
    environments.find(({ environmentId: id }) => id === primaryEnvironmentId)?.environmentId ??
    environments[0]?.environmentId ??
    null;
  const marketplaceQuery = useEnvironmentQuery(
    environmentId ? serverEnvironment.marketplace({ environmentId, input: {} }) : null,
  );
  const addSource = useAtomCommand(serverEnvironment.marketplaceAddSource, {
    reportFailure: false,
  });
  const removeSource = useAtomCommand(serverEnvironment.marketplaceRemoveSource, {
    reportFailure: false,
  });
  const [sourceUrl, setSourceUrl] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketplaceCatalogEntry | null>(null);
  const [isAddingSource, setIsAddingSource] = useState(false);
  const [removingSourceId, setRemovingSourceId] = useState<string | null>(null);
  const autoUpdatePackage = useAtomCommand(serverEnvironment.marketplaceUpdate, {
    reportFailure: false,
  });
  const autoUpdateAttemptedRef = useRef<Set<string>>(new Set());
  const snapshot = marketplaceQuery.data;
  const packages = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!snapshot || !normalized) return snapshot?.packages ?? [];
    return snapshot.packages.filter(({ package: entry, sourceName }) =>
      [entry.name, entry.description, entry.type, entry.publisher ?? "", sourceName, ...entry.tags]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [query, snapshot]);
  const packageGroups = useMemo(() => groupMarketplacePackagesByType(packages), [packages]);

  // Apply updates for installations the user flagged as auto-update, once per
  // installation per mount. Sensitive inputs are reused server-side from the
  // installed provider environment, so an empty input record is sufficient.
  useEffect(() => {
    if (!snapshot || !environmentId) return;
    for (const installation of snapshot.installations) {
      if (!installation.autoUpdate || autoUpdateAttemptedRef.current.has(installation.id)) {
        continue;
      }
      const entry = snapshot.packages.find(
        (candidate) =>
          candidate.sourceId === installation.sourceId &&
          candidate.package.id === installation.packageId,
      );
      if (!entry?.updateAvailable) continue;
      autoUpdateAttemptedRef.current.add(installation.id);
      void autoUpdatePackage({
        environmentId,
        input: { installationId: installation.id, inputs: {} },
      }).then((result) => {
        if (result._tag === "Success") {
          toastManager.add({
            type: "success",
            title: `${installation.packageName} updated automatically`,
          });
          marketplaceQuery.refresh();
          return;
        }
        toastManager.add({
          type: "error",
          title: `Could not auto-update ${installation.packageName}`,
          description: errorMessage(result),
        });
      });
    }
    // marketplaceQuery.refresh and autoUpdatePackage are stable atom-backed
    // references; snapshot identity drives re-evaluation after each refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, environmentId]);

  const handleAddSource = async () => {
    if (!environmentId || !sourceUrl.trim() || isAddingSource) return;
    setIsAddingSource(true);
    const result = await addSource({ environmentId, input: { url: sourceUrl.trim() } });
    setIsAddingSource(false);
    if (result._tag === "Success") {
      setSourceUrl("");
      marketplaceQuery.refresh();
      toastManager.add({ type: "success", title: "Marketplace source added" });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not add source",
      description: errorMessage(result),
    });
  };

  const handleRemoveSource = async (sourceId: MarketplaceId) => {
    if (!environmentId || removingSourceId) return;
    setRemovingSourceId(sourceId);
    const result = await removeSource({ environmentId, input: { sourceId } });
    setRemovingSourceId(null);
    if (result._tag === "Success") {
      marketplaceQuery.refresh();
      toastManager.add({ type: "success", title: "Marketplace source removed" });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not remove source",
      description: errorMessage(result),
    });
  };

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        {...searchableSetting("marketplace")}
        icon={<StoreIcon className="size-4" />}
        headerAction={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh marketplace"
            disabled={!environmentId || marketplaceQuery.isPending}
            onClick={marketplaceQuery.refresh}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        }
      >
        <SettingsRow
          title="Device"
          description="Packages are installed on the selected execution environment."
          control={
            <select
              value={environmentId ?? ""}
              disabled={environments.length === 0}
              onChange={(event) =>
                setRequestedEnvironmentId(event.currentTarget.value as EnvironmentId)
              }
              className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm"
            >
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </option>
              ))}
            </select>
          }
        />
        {!environmentId ? (
          <SettingsRow
            title={isReady ? "No connected devices" : "Loading devices"}
            description="Connect an execution environment to browse and install packages."
          />
        ) : null}
        {marketplaceQuery.error ? (
          <SettingsRow title="Marketplace unavailable" description={marketplaceQuery.error} />
        ) : null}
      </SettingsSection>

      <SettingsSection {...searchableSetting("marketplace-sources")}>
        <SettingsRow
          title="Add a community repository"
          description="Paste a catalog JSON URL, a repository directory URL, or a public GitHub repository URL."
        >
          <div className="flex gap-2 pb-2 pt-3">
            <Input
              aria-label="Marketplace repository URL"
              placeholder="https://github.com/owner/marketplace"
              value={sourceUrl}
              disabled={!environmentId || isAddingSource}
              onChange={(event) => setSourceUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddSource();
              }}
            />
            <Button
              disabled={!environmentId || !sourceUrl.trim() || isAddingSource}
              onClick={() => void handleAddSource()}
            >
              <PlusIcon className="size-4" />
              Add
            </Button>
          </div>
        </SettingsRow>
        {snapshot?.sources.map((source) => (
          <SettingsRow
            key={source.id}
            title={source.name}
            description={source.url}
            status={source.official ? "Official repository" : "Community repository"}
            control={
              source.removable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removingSourceId !== null}
                  onClick={() => void handleRemoveSource(source.id)}
                >
                  <Trash2Icon className="size-3.5" />
                  Remove
                </Button>
              ) : null
            }
          />
        ))}
        {snapshot?.sourceErrors.map((sourceError) => (
          <SettingsRow
            key={sourceError.sourceId}
            title={`${sourceError.sourceName} could not be loaded`}
            description={sourceError.detail}
            className="bg-destructive/5"
          />
        ))}
      </SettingsSection>

      <SettingsSection {...searchableSetting("marketplace-packages")}>
        <div className="px-3 pb-3 sm:px-4">
          <Input
            type="search"
            placeholder="Search packages, types, publishers, or tags"
            aria-label="Search marketplace packages"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {marketplaceQuery.isPending && !snapshot ? (
          <SettingsRow title="Loading packages" description="Reading configured marketplaces." />
        ) : packages.length === 0 ? (
          <SettingsRow
            title={query ? "No matching packages" : "No packages available"}
            description={
              query ? "Try another search." : "Add a repository with published packages."
            }
          />
        ) : (
          <div className="grid gap-5 pb-2">
            {packageGroups.map((group) => (
              <div key={group.type} className="grid gap-2">
                <h3 className="px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground sm:px-4">
                  {group.label}
                </h3>
                <div className={cn("grid gap-3 px-3 sm:grid-cols-2 sm:px-4 lg:grid-cols-3")}>
                  {group.entries.map((entry) => (
                    <PackageCard
                      key={`${entry.sourceId}/${entry.package.id}`}
                      entry={entry}
                      onOpen={() => setSelected(entry)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {environmentId ? (
        <PackageDialog
          environmentId={environmentId}
          selected={selected}
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          onChanged={marketplaceQuery.refresh}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
