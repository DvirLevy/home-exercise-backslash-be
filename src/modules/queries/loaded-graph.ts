import type { GraphSnapshot } from '../../graph-engine/graph-snapshot';
import type { FilterRecord } from '../filters/filter.types';
import type { EdgeRecord, NodeRecord } from '../graphs/graph.types';

/**
 * What the in-memory store keeps per graph: the query snapshot plus the filter records it was
 * built from, so match counts and definitions always describe the same moment as the snapshot.
 */
export interface LoadedGraph {
  snapshot: GraphSnapshot<NodeRecord, EdgeRecord>;
  filters: readonly FilterRecord[];
  /** Keys of stored filters whose rule could not be compiled; they have no entry in the filter index. */
  unusable: ReadonlySet<string>;
}
