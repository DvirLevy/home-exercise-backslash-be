import type { EngineEdge, EngineNode, GraphSource, NodePredicate } from './types';

/** The stored graph breaks a rule the database enforces (unknown node, repeated name). A bug, not bad input. */
export class GraphIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphIntegrityError';
  }
}

const NO_NAMES: readonly string[] = [];
const NO_EDGES: readonly never[] = [];

/**
 * An immutable, in-memory picture of one graph at one version.
 *
 * Adjacency lists in both directions, so a search can run forwards from the start nodes and
 * backwards from the end nodes:
 *   outgoing: node -> (target -> edge)      incoming: node -> set of sources
 * Only nodes that have edges appear in those maps. `filterIndex` answers "which nodes match
 * filter X" without evaluating anything at query time.
 *
 * Nothing mutates a snapshot after construction, so a query running on an old snapshot stays
 * consistent while a write swaps in a new one.
 */
export class GraphSnapshot<N extends EngineNode, E extends EngineEdge> {
  private realNames: ReadonlySet<string> | undefined;

  constructor(
    readonly graphId: string,
    readonly version: number,
    /** In the order of the uploaded file. */
    readonly nodes: ReadonlyMap<string, N>,
    readonly outgoing: ReadonlyMap<string, ReadonlyMap<string, E>>,
    readonly incoming: ReadonlyMap<string, ReadonlySet<string>>,
    /** Filter key -> names of the (non-placeholder) nodes matching it. */
    readonly filterIndex: ReadonlyMap<string, ReadonlySet<string>>,
    readonly edgeCount: number,
  ) {}

  successors(name: string): Iterable<string> {
    return this.outgoing.get(name)?.keys() ?? NO_NAMES;
  }

  predecessors(name: string): Iterable<string> {
    return this.incoming.get(name) ?? NO_NAMES;
  }

  outgoingEdges(name: string): Iterable<E> {
    return this.outgoing.get(name)?.values() ?? NO_EDGES;
  }

  /** Names of all nodes that are not placeholders; the universe `not` and an empty `and` work against. */
  realNodeNames(): ReadonlySet<string> {
    if (!this.realNames) {
      const names = new Set<string>();
      for (const node of this.nodes.values()) if (!node.isPlaceholder) names.add(node.name);
      this.realNames = names;
    }
    return this.realNames;
  }
}

/**
 * Builds a snapshot and evaluates every filter once, so queries never run predicates.
 * Placeholders never enter the filter index, whatever a predicate would say.
 *
 * @throws GraphIntegrityError for a repeated node name or an edge to an unknown node.
 */
export function buildSnapshot<N extends EngineNode, E extends EngineEdge>(
  source: GraphSource<N, E>,
  filters: ReadonlyMap<string, NodePredicate<N>> = new Map(),
): GraphSnapshot<N, E> {
  const nodes = new Map<string, N>();
  for (const node of source.nodes) {
    if (nodes.has(node.name)) {
      throw new GraphIntegrityError(`Graph ${source.id} has two nodes named "${node.name}"`);
    }
    nodes.set(node.name, node);
  }

  const outgoing = new Map<string, Map<string, E>>();
  const incoming = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const edge of source.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw new GraphIntegrityError(`Graph ${source.id} has an edge ${edge.from} -> ${edge.to} to an unknown node`);
    }
    let targets = outgoing.get(edge.from);
    if (!targets) outgoing.set(edge.from, (targets = new Map()));
    if (targets.has(edge.to)) continue; // a repeated edge changes nothing

    targets.set(edge.to, edge);
    let sources = incoming.get(edge.to);
    if (!sources) incoming.set(edge.to, (sources = new Set()));
    sources.add(edge.from);
    edgeCount += 1;
  }

  const filterIndex = new Map<string, Set<string>>();
  for (const [key, predicate] of filters) {
    const matches = new Set<string>();
    for (const node of nodes.values()) {
      if (!node.isPlaceholder && predicate(node)) matches.add(node.name);
    }
    filterIndex.set(key, matches);
  }

  return new GraphSnapshot(source.id, source.version, nodes, outgoing, incoming, filterIndex, edgeCount);
}
