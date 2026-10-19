import { buildSnapshot, type GraphSnapshot } from '../../src/graph-engine/graph-snapshot';
import type { RouteResult } from '../../src/graph-engine/route-finder';
import type { EngineEdge, EngineNode } from '../../src/graph-engine/types';

export type TestNode = EngineNode;
export type TestEdge = EngineEdge & { extra?: unknown };

export interface GraphSpec {
  /** Names of the real nodes, in file order. */
  nodes: string[];
  /** Placeholder nodes (referenced but never defined), appended after the real ones. */
  placeholders?: string[];
  edges: Array<[string, string]>;
  /** Filter key -> names of the nodes that match it. */
  filters?: Record<string, string[]>;
  id?: string;
  version?: number;
}

/** Builds a snapshot from a compact description; filters match by name. */
export function snap(spec: GraphSpec): GraphSnapshot<TestNode, TestEdge> {
  const nodes: TestNode[] = [
    ...spec.nodes.map((name) => ({ name, isPlaceholder: false })),
    ...(spec.placeholders ?? []).map((name) => ({ name, isPlaceholder: true })),
  ];
  const filters = new Map(
    Object.entries(spec.filters ?? {}).map(([key, names]) => {
      const wanted = new Set(names);
      return [key, (node: TestNode) => wanted.has(node.name)] as const;
    }),
  );
  return buildSnapshot(
    {
      id: spec.id ?? 'g',
      version: spec.version ?? 1,
      nodes,
      edges: spec.edges.map(([from, to]): TestEdge => ({ from, to })),
    },
    filters,
  );
}

export const nodeNames = (result: RouteResult<TestNode, TestEdge>): string[] => result.nodes.map((n) => n.node.name);

/** Edges as sorted "from>to" strings, for order-independent comparison. */
export const edgeNames = (result: RouteResult<TestNode, TestEdge>): string[] =>
  result.edges.map((e) => `${e.from}>${e.to}`).sort();

export const sorted = (names: Iterable<string>): string[] => [...names].sort();
