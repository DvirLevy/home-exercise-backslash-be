import { collectFilterKeys, resolveCondition, type Condition } from './conditions';
import type { GraphSnapshot } from './graph-snapshot';
import { reachable } from './traversal';
import type { EngineEdge, EngineNode } from './types';

export type Role = 'start' | 'end' | 'through';

/**
 * A route query. A role left out puts no constraint on that part of the route.
 *   start    the route begins at a node matching this
 *   end      the route ends at a node matching this
 *   through  the route passes through at least one node matching this (a start or end node counts)
 */
export interface RouteQuery {
  start?: Condition | undefined;
  end?: Condition | undefined;
  through?: Condition | undefined;
}

export interface RouteNode<N> {
  node: N;
  /** Roles this node plays on at least one route: a real start, a real end, or a through node. */
  roles: Role[];
  /** Filters named in the query that this node matches. */
  filters: string[];
}

export interface RouteResult<N, E> {
  nodes: RouteNode<N>[];
  edges: E[];
}

/**
 * The subgraph made of every node and edge that lies on at least one route satisfying the query.
 *
 * Routes are walks (a node may repeat, so a route can go round a cycle). Walks make the problem
 * exactly solvable in linear time, where "simple paths only" is NP-hard; on a graph without
 * cycles the two are identical.
 *
 * With F = nodes reachable from the start nodes and B = nodes that can reach an end node:
 *   no through filter:  node x is on a route <=> x in F and x in B;  edge u->v <=> u in F and v in B
 *   with a through set M: let F1 = reachable from (M within F) and B1 = reaches (M within B), then
 *     node x <=> (x in F1 and x in B) or (x in F and x in B1)
 *     edge u->v <=> (u in F1 and v in B) or (u in F and v in B1)
 * F1 holds the nodes reachable by a walk that has already passed through M, B1 those that can
 * still pass through M on the way to an end node. Four breadth-first searches in the worst case.
 *
 * @throws UnknownFilterError when a condition names a filter the snapshot does not have.
 */
export function findRoutes<N extends EngineNode, E extends EngineEdge>(
  snapshot: GraphSnapshot<N, E>,
  query: RouteQuery,
): RouteResult<N, E> {
  const starts = query.start ? resolveCondition(snapshot, query.start) : null;
  const ends = query.end ? resolveCondition(snapshot, query.end) : null;
  const through = query.through ? resolveCondition(snapshot, query.through) : null;

  const filterKeys = [query.start, query.end, query.through].flatMap((condition) =>
    condition ? collectFilterKeys(condition) : [],
  );
  const queriedFilters = [...new Set(filterKeys)];

  // No constraint at all: the whole graph.
  if (!starts && !ends && !through) {
    return {
      nodes: [...snapshot.nodes.values()].map((node) => ({ node, roles: [], filters: [] })),
      edges: [...snapshot.nodes.keys()].flatMap((name) => [...snapshot.outgoingEdges(name)]),
    };
  }
  // A constrained role nobody satisfies: no route exists.
  if (starts?.size === 0 || ends?.size === 0 || through?.size === 0) return { nodes: [], edges: [] };

  const forward = reachable((name) => snapshot.successors(name), starts ?? snapshot.nodes.keys());
  const backward = reachable((name) => snapshot.predecessors(name), ends ?? snapshot.nodes.keys());

  let forwardThrough: ReadonlySet<string> | null = null;
  let backwardThrough: ReadonlySet<string> | null = null;
  if (through) {
    forwardThrough = reachable((name) => snapshot.successors(name), intersect(through, forward));
    backwardThrough = reachable((name) => snapshot.predecessors(name), intersect(through, backward));
  }

  const onRoute = (name: string): boolean =>
    through
      ? (forwardThrough!.has(name) && backward.has(name)) || (forward.has(name) && backwardThrough!.has(name))
      : forward.has(name) && backward.has(name);

  const edgeOnRoute = (from: string, to: string): boolean =>
    through
      ? (forwardThrough!.has(from) && backward.has(to)) || (forward.has(from) && backwardThrough!.has(to))
      : forward.has(from) && backward.has(to);

  // A real start is a start node from which an end can still be reached (through M when asked);
  // a real end is the mirror image.
  const reachesEnd = backwardThrough ?? backward;
  const reachedFromStart = forwardThrough ?? forward;

  const nodes: RouteNode<N>[] = [];
  const edges: E[] = [];
  for (const [name, node] of snapshot.nodes) {
    if (!onRoute(name)) continue;

    const roles: Role[] = [];
    if (starts?.has(name) && reachesEnd.has(name)) roles.push('start');
    if (through?.has(name)) roles.push('through');
    if (ends?.has(name) && reachedFromStart.has(name)) roles.push('end');

    nodes.push({
      node,
      roles,
      filters: queriedFilters.filter((key) => snapshot.filterIndex.get(key)?.has(name)),
    });

    for (const edge of snapshot.outgoingEdges(name)) {
      if (edgeOnRoute(name, edge.to)) edges.push(edge);
    }
  }
  return { nodes, edges };
}

function intersect(small: ReadonlySet<string>, other: ReadonlySet<string>): string[] {
  const names: string[] = [];
  for (const name of small) if (other.has(name)) names.push(name);
  return names;
}
