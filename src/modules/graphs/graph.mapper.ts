import type { Edge, Graph, Node } from '../../generated/prisma/client';
import { Prisma } from '../../infrastructure/prisma';
import type { JsonObject, JsonValue } from '../../shared/json';
import type { EdgeRecord, GraphSummary, NodeRecord } from './graph.types';

type GraphWithCounts = Graph & { _count: { nodes: number; edges: number } };

export function toGraphSummary(graph: GraphWithCounts): GraphSummary {
  return {
    id: graph.id,
    name: graph.name,
    version: graph.version,
    nodeCount: graph._count.nodes,
    edgeCount: graph._count.edges,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
}

export function toNodeRecord(node: Node): NodeRecord {
  return {
    name: node.name,
    kind: node.kind,
    language: node.language,
    path: node.path,
    publicExposed: node.publicExposed,
    isPlaceholder: node.isPlaceholder,
    vulnerabilities: node.vulnerabilities as JsonValue[],
    metadata: node.metadata as JsonObject | null,
    extra: node.extra as JsonObject | null,
  };
}

export function toEdgeRecord(edge: Edge): EdgeRecord {
  return { from: edge.fromName, to: edge.toName };
}

/** A nullable JSON column needs `DbNull` to store SQL NULL; a plain `null` would mean JSON null. */
function nullableJson(value: JsonObject | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

export function toNodeCreateInput(graphId: string, node: NodeRecord, position: number): Prisma.NodeCreateManyInput {
  return {
    graphId,
    name: node.name,
    position,
    kind: node.kind,
    language: node.language,
    path: node.path,
    publicExposed: node.publicExposed,
    isPlaceholder: node.isPlaceholder,
    vulnerabilities: node.vulnerabilities as Prisma.InputJsonValue,
    metadata: nullableJson(node.metadata),
    extra: nullableJson(node.extra),
  };
}

export function toEdgeCreateInput(graphId: string, edge: EdgeRecord): Prisma.EdgeCreateManyInput {
  return { graphId, fromName: edge.from, toName: edge.to };
}
