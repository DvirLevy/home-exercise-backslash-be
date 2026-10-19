import type { GraphData, GraphSummary, NewGraph, StoredGraph } from './graph.types';

export interface GraphRepository {
  /** Inserts the graph (version 1) with its nodes and edges. Call inside a transaction. */
  create(graph: NewGraph): Promise<GraphSummary>;

  /** All graphs, newest first, without their content. */
  list(): Promise<GraphSummary[]>;

  findSummary(id: string): Promise<GraphSummary | null>;

  /** The graph with nodes (in file order) and edges, read from one consistent snapshot. */
  findWithData(id: string): Promise<StoredGraph | null>;

  /** Changes the name only; the version is not bumped. Throws NotFoundError. */
  rename(id: string, name: string): Promise<GraphSummary>;

  /**
   * Increments the version and returns the new one. This is a single UPDATE, so it also locks the
   * row until the transaction ends: concurrent writers to the same graph run one after the other.
   * With `expectedVersion`, a mismatch throws ConflictError('VERSION_CONFLICT'); a missing graph
   * throws NotFoundError. Always call it first in a write transaction.
   */
  bumpVersion(id: string, expectedVersion?: number): Promise<number>;

  /** Replaces all nodes and edges. Does not change the version; pair it with bumpVersion. */
  replaceData(id: string, data: GraphData): Promise<void>;

  /** Deletes the graph; nodes, edges and filters go with it. Throws NotFoundError. */
  delete(id: string): Promise<void>;
}
