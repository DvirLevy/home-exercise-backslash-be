/**
 * The graph engine knows nothing about HTTP, Express, Prisma or the rule language. It works on
 * anything shaped like these, so the stored records can be passed in as they are.
 */
export interface EngineNode {
  name: string;
  /** Placeholders (referenced but never defined) are part of the graph but never match a filter. */
  isPlaceholder: boolean;
}

export interface EngineEdge {
  from: string;
  to: string;
}

export type NodePredicate<N> = (node: N) => boolean;

/** A graph as loaded from storage, ready to be turned into a snapshot. */
export interface GraphSource<N extends EngineNode, E extends EngineEdge> {
  id: string;
  version: number;
  nodes: readonly N[];
  edges: readonly E[];
}
