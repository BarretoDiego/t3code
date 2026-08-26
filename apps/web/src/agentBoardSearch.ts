import {
  EMPTY_AGENT_BOARD_FILTERS,
  type AgentBoardFilters,
} from "@t3tools/client-runtime/agent-board";

export interface AgentBoardSearch {
  readonly environments?: string;
  readonly projects?: string;
  readonly providers?: string;
  readonly instances?: string;
  readonly models?: string;
  readonly active?: boolean;
}

function parseList(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length > 4_000) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      ),
    ].slice(0, 50);
  } catch {
    return [];
  }
}

export function parseAgentBoardSearch(raw: Record<string, unknown>): AgentBoardSearch {
  const environments = parseList(raw.environments);
  const projects = parseList(raw.projects);
  const providers = parseList(raw.providers);
  const instances = parseList(raw.instances);
  const models = parseList(raw.models);
  return {
    ...(environments.length > 0 ? { environments: JSON.stringify(environments) } : {}),
    ...(projects.length > 0 ? { projects: JSON.stringify(projects) } : {}),
    ...(providers.length > 0 ? { providers: JSON.stringify(providers) } : {}),
    ...(instances.length > 0 ? { instances: JSON.stringify(instances) } : {}),
    ...(models.length > 0 ? { models: JSON.stringify(models) } : {}),
    ...(raw.active === false || raw.active === "false" ? { active: false } : {}),
  };
}

export function filtersFromAgentBoardSearch(search: AgentBoardSearch): AgentBoardFilters {
  return {
    ...EMPTY_AGENT_BOARD_FILTERS,
    environmentIds: parseList(search.environments),
    projectKeys: parseList(search.projects),
    providerDrivers: parseList(search.providers),
    providerInstanceKeys: parseList(search.instances),
    models: parseList(search.models),
    onlyActive: search.active !== false,
  };
}

export function encodeAgentBoardFilterList(values: readonly string[]): string | undefined {
  return values.length === 0 ? undefined : JSON.stringify(values);
}
