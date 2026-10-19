import type { GraphStore } from '../../graph-engine/graph-store';
import { findRoutes, type RouteResult } from '../../graph-engine/route-finder';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../../http/errors';
import type { EdgeRecord, NodeRecord } from '../graphs/graph.types';
import type { LoadedGraph } from './loaded-graph';
import { ROLES, toRouteQuery, type RouteRoles } from './query.parser';

export interface RouteAnswer {
  graphId: string;
  version: number;
  applied: RouteRoles;
  result: RouteResult<NodeRecord, EdgeRecord>;
}

export class QueryService {
  constructor(private readonly store: GraphStore<LoadedGraph>) {}

  /**
   * @throws NotFoundError for an unknown graph, ValidationError (UNKNOWN_FILTER) listing every
   *         filter the graph does not have, ConflictError (FILTER_UNAVAILABLE) for a stored
   *         filter whose rule can no longer be compiled.
   */
  async routes(graphId: string, roles: RouteRoles): Promise<RouteAnswer> {
    const loaded = await this.store.get(graphId);
    if (!loaded) throw new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND');

    this.assertFiltersUsable(loaded, roles);
    const result = findRoutes(loaded.snapshot, toRouteQuery(roles));
    return { graphId, version: loaded.snapshot.version, applied: roles, result };
  }

  private assertFiltersUsable(loaded: LoadedGraph, roles: RouteRoles): void {
    const unknown: ErrorDetail[] = [];
    const unavailable = new Set<string>();

    for (const role of ROLES) {
      for (const key of roles[role]) {
        if (loaded.snapshot.filterIndex.has(key)) continue;
        if (loaded.unusable.has(key)) unavailable.add(key);
        else unknown.push({ path: role, message: `Unknown filter "${key}"` });
      }
    }

    if (unknown.length > 0) {
      throw new ValidationError('The query uses filters this graph does not have', unknown, 'UNKNOWN_FILTER');
    }
    if (unavailable.size > 0) {
      throw new ConflictError(
        `Filter ${[...unavailable].map((key) => `"${key}"`).join(', ')} cannot be used: its stored rule does not compile. Replace it with a valid rule.`,
        'FILTER_UNAVAILABLE',
      );
    }
  }
}
