import type { AgentProfile } from "@t3tools/contracts";

/**
 * Filter profiles for the `#slug` composer menu. Matching is a plain
 * case-insensitive substring over slug, name, and description, slug-prefixed
 * results first.
 */
export function searchAgentProfiles(
  profiles: ReadonlyArray<AgentProfile>,
  query: string,
): ReadonlyArray<AgentProfile> {
  const normalizedQuery = query.trim().toLowerCase();
  const enabled = profiles.filter((profile) => profile.enabled);
  if (normalizedQuery.length === 0) {
    return enabled;
  }
  const matches = enabled.filter((profile) =>
    [profile.slug, profile.name, profile.description].some((field) =>
      field.toLowerCase().includes(normalizedQuery),
    ),
  );
  return matches.toSorted((left, right) => {
    const leftSlug = left.slug.startsWith(normalizedQuery) ? 0 : 1;
    const rightSlug = right.slug.startsWith(normalizedQuery) ? 0 : 1;
    return leftSlug - rightSlug || left.name.localeCompare(right.name);
  });
}
