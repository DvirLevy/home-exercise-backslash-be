import type { EngineEdge, EngineNode } from './types';
import type { GraphSnapshot } from './graph-snapshot';

/**
 * What a query role (start, end, through) asks for, as a small tree. Adding a new way to combine
 * filters means adding a case here; the route search itself only ever sees sets of node names.
 *
 *   { filter: "public" }                 nodes matching the filter
 *   { or: [...] }  { and: [...] }        union / intersection
 *   { not: c }                           every non-placeholder node that does not match c
 */
export type Condition =
  | { filter: string }
  | { or: Condition[] }
  | { and: Condition[] }
  | { not: Condition };

export class UnknownFilterError extends Error {
  constructor(readonly key: string) {
    super(`Unknown filter "${key}"`);
    this.name = 'UnknownFilterError';
  }
}

/** Conditions are built by the application, but a runaway tree should fail clearly, not overflow the stack. */
export const MAX_CONDITION_DEPTH = 32;

/**
 * The names of the nodes satisfying a condition. An empty `or` matches nothing; an empty `and`
 * matches every non-placeholder node.
 *
 * @throws UnknownFilterError when the condition names a filter the snapshot does not have.
 */
export function resolveCondition<N extends EngineNode, E extends EngineEdge>(
  snapshot: GraphSnapshot<N, E>,
  condition: Condition,
  depth = 1,
): ReadonlySet<string> {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new RangeError(`A condition is nested deeper than ${MAX_CONDITION_DEPTH} levels`);
  }

  if ('filter' in condition) {
    const matches = snapshot.filterIndex.get(condition.filter);
    if (!matches) throw new UnknownFilterError(condition.filter);
    return matches;
  }
  if ('or' in condition) {
    const union = new Set<string>();
    for (const child of condition.or) for (const name of resolveCondition(snapshot, child, depth + 1)) union.add(name);
    return union;
  }
  if ('and' in condition) {
    if (condition.and.length === 0) return snapshot.realNodeNames();
    const sets = condition.and.map((child) => resolveCondition(snapshot, child, depth + 1));
    // Walk the smallest set and keep the names every other set also has.
    const [smallest, ...others] = [...sets].sort((a, b) => a.size - b.size) as [ReadonlySet<string>, ...ReadonlySet<string>[]];
    const intersection = new Set<string>();
    for (const name of smallest) if (others.every((set) => set.has(name))) intersection.add(name);
    return intersection;
  }

  const excluded = resolveCondition(snapshot, condition.not, depth + 1);
  const complement = new Set<string>();
  for (const name of snapshot.realNodeNames()) if (!excluded.has(name)) complement.add(name);
  return complement;
}

/** Every filter key a condition mentions, in order of first appearance. */
export function collectFilterKeys(condition: Condition): string[] {
  const keys = new Set<string>();
  const pending: Condition[] = [condition];
  while (pending.length > 0) {
    const current = pending.shift()!;
    if ('filter' in current) keys.add(current.filter);
    else if ('or' in current) pending.unshift(...current.or);
    else if ('and' in current) pending.unshift(...current.and);
    else pending.unshift(current.not);
  }
  return [...keys];
}
