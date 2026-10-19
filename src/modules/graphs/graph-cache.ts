/**
 * What the write path needs from the in-memory graph cache: drop an entry once a write has
 * committed. The real implementation (GraphStore) arrives with the query engine.
 */
export interface GraphCache {
  invalidate(graphId: string): void;
}

export const noopGraphCache: GraphCache = { invalidate: () => undefined };
