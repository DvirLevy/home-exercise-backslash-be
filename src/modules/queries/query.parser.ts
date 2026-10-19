import type { Condition } from '../../graph-engine/conditions';
import type { RouteQuery } from '../../graph-engine/route-finder';
import type { RouteQueryParams } from './query.schemas';

export const ROLES = ['start', 'end', 'through'] as const;

/** The filters asked for in each role, repeats removed, in the order given. */
export type RouteRoles = Record<(typeof ROLES)[number], string[]>;

export function toRouteRoles(params: RouteQueryParams): RouteRoles {
  const list = (value: string | string[] | undefined): string[] =>
    value === undefined ? [] : [...new Set(Array.isArray(value) ? value : [value])];
  return { start: list(params.start), end: list(params.end), through: list(params.through) };
}

/**
 * Several filters of one role are joined with OR; the roles themselves are combined by the route
 * search (all must hold). A richer syntax (AND within a role, negation) only needs a new way to
 * build a Condition here: the engine already evaluates and / not.
 */
function roleCondition(keys: string[]): Condition | undefined {
  if (keys.length === 0) return undefined;
  if (keys.length === 1) return { filter: keys[0]! };
  return { or: keys.map((filter) => ({ filter })) };
}

export function toRouteQuery(roles: RouteRoles): RouteQuery {
  return { start: roleCondition(roles.start), end: roleCondition(roles.end), through: roleCondition(roles.through) };
}
