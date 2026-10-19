import { presentNode } from '../graphs/graph.presenter';
import type { RouteResultResponse } from './query.schemas';
import type { RouteAnswer } from './query.service';

export function presentRoutes({ graphId, version, applied, result }: RouteAnswer): RouteResultResponse {
  return {
    graphId,
    version,
    applied,
    nodes: result.nodes.map(({ node, roles, filters }) => ({ ...presentNode(node), matched: { roles, filters } })),
    // Like the graph itself: `extra` only on edges that have one.
    edges: result.edges.map((edge) =>
      edge.extra === null ? { from: edge.from, to: edge.to } : { from: edge.from, to: edge.to, extra: edge.extra },
    ),
  };
}
