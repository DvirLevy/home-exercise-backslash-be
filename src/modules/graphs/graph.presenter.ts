import type { JsonObject } from '../../shared/json';
import type {
  GraphDetailResponse,
  GraphNodeResponse,
  GraphSummaryResponse,
  GraphWriteResponse,
} from './graph.schemas';
import type { GraphSummary, NodeRecord, StoredGraph } from './graph.types';

export function presentSummary(summary: GraphSummary): GraphSummaryResponse {
  return {
    id: summary.id,
    name: summary.name,
    version: summary.version,
    nodeCount: summary.nodeCount,
    edgeCount: summary.edgeCount,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

export function presentWriteResult(summary: GraphSummary, placeholders: string[]): GraphWriteResponse {
  return { ...presentSummary(summary), placeholders };
}

export function presentNode(node: NodeRecord): GraphNodeResponse {
  return {
    name: node.name,
    kind: node.kind,
    language: node.language,
    path: node.path,
    publicExposed: node.publicExposed,
    placeholder: node.isPlaceholder,
    vulnerabilities: node.vulnerabilities as JsonObject[],
    metadata: node.metadata,
    extra: node.extra,
  };
}

export function presentGraph(graph: StoredGraph): GraphDetailResponse {
  return {
    id: graph.id,
    name: graph.name,
    version: graph.version,
    extra: graph.extra,
    nodes: graph.nodes.map(presentNode),
    // `extra` is left out of edges that have none: with hundreds of thousands of edges it adds up.
    edges: graph.edges.map((edge) =>
      edge.extra === null ? { from: edge.from, to: edge.to } : { from: edge.from, to: edge.to, extra: edge.extra },
    ),
  };
}
