import {
  AUTOMATION_ADMINISTRATIVE_EVENT_TYPES,
  type AutomationEvent,
  type AutomationEventFilter,
} from "@t3tools/contracts";

const TYPE_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9._-]*)*$/;
const TYPE_PREFIX_SUFFIX = ".*";

const administrativeTypes = new Set<string>(AUTOMATION_ADMINISTRATIVE_EVENT_TYPES);

/** How one entry of `filter.types` selects events: an exact type, or everything under a prefix. */
type TypeSelector =
  | { readonly kind: "exact"; readonly type: string }
  | { readonly kind: "prefix"; readonly prefix: string };

export const typeSelectors = (types: ReadonlyArray<string>): ReadonlyArray<TypeSelector> =>
  types.map((type) =>
    type.endsWith(TYPE_PREFIX_SUFFIX)
      ? { kind: "prefix", prefix: type.slice(0, -1) }
      : { kind: "exact", type },
  );

/** The reason a filter cannot be used, or null when it is well formed. */
export const filterProblem = (filter: AutomationEventFilter): string | null => {
  for (const type of filter.types ?? []) {
    const name = type.endsWith(TYPE_PREFIX_SUFFIX) ? type.slice(0, -2) : type;
    if (!TYPE_PATTERN.test(name)) {
      return `'${type}' is not an event type. Use an exact type such as turn.completed, or a prefix such as task.*.`;
    }
  }
  return null;
};

const includes = <A>(allowed: ReadonlyArray<A> | undefined, value: A | undefined) =>
  allowed === undefined || allowed.length === 0 || (value !== undefined && allowed.includes(value));

/**
 * Whether an event passes a filter. Every listed dimension must match; a
 * filter that names no types sees every type except the administrative ones.
 */
export const matchesFilter = (
  event: AutomationEvent,
  filter: AutomationEventFilter | undefined,
): boolean => {
  const types = filter?.types ?? [];
  const typeMatches =
    types.length === 0
      ? !administrativeTypes.has(event.type)
      : typeSelectors(types).some((selector) =>
          selector.kind === "exact"
            ? selector.type === event.type
            : event.type.startsWith(selector.prefix),
        );
  if (!typeMatches) return false;
  if (filter === undefined) return true;
  return (
    includes(filter.originEnvironmentIds, event.origin.environmentId) &&
    includes(filter.nodeIds, event.scope.nodeId ?? event.origin.nodeId) &&
    includes(filter.projectIds, event.scope.projectId) &&
    includes(filter.threadIds, event.scope.threadId) &&
    includes(filter.parentThreadIds, event.scope.parentThreadId) &&
    includes(filter.rootThreadIds, event.scope.rootThreadId) &&
    includes(filter.orchestratorIds, event.scope.orchestratorId) &&
    includes(filter.taskIds, event.scope.taskId)
  );
};
