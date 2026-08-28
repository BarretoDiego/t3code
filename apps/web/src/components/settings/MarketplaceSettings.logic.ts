import { PROVIDER_TEMPLATE_PACKAGE_TYPE, type MarketplaceCatalogEntry } from "@t3tools/contracts";

export interface MarketplacePackageGroup {
  readonly type: string;
  readonly label: string;
  readonly entries: ReadonlyArray<MarketplaceCatalogEntry>;
}

/** Display order for known package types; unknown types follow alphabetically. */
const PACKAGE_TYPE_ORDER: ReadonlyArray<string> = [
  PROVIDER_TEMPLATE_PACKAGE_TYPE,
  "skill",
  "agent",
  "specialist",
];

export function packageTypePluralLabel(type: string): string {
  const label = type
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${label}s`;
}

function packageTypeSortIndex(type: string): number {
  const known = PACKAGE_TYPE_ORDER.indexOf(type);
  return known === -1 ? PACKAGE_TYPE_ORDER.length : known;
}

/**
 * Group catalog entries by package type for sectioned rendering. Groups and
 * their entries keep a stable order: known categories first in
 * PACKAGE_TYPE_ORDER, then unknown types alphabetically, with the catalog's
 * own ordering preserved inside each group.
 */
export function groupMarketplacePackagesByType(
  entries: ReadonlyArray<MarketplaceCatalogEntry>,
): ReadonlyArray<MarketplacePackageGroup> {
  const byType = new Map<string, MarketplaceCatalogEntry[]>();
  for (const entry of entries) {
    const bucket = byType.get(entry.package.type);
    if (bucket) {
      bucket.push(entry);
    } else {
      byType.set(entry.package.type, [entry]);
    }
  }
  return [...byType.entries()]
    .sort(([left], [right]) => {
      const orderDelta = packageTypeSortIndex(left) - packageTypeSortIndex(right);
      return orderDelta !== 0 ? orderDelta : left.localeCompare(right);
    })
    .map(([type, groupEntries]) => ({
      type,
      label: packageTypePluralLabel(type),
      entries: groupEntries,
    }));
}
