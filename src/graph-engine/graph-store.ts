export type SnapshotLoader<S> = (graphId: string) => Promise<S | null>;

export interface GraphStoreOptions {
  /** Snapshots kept in memory; the least recently used one is dropped beyond this. */
  maxEntries?: number;
}

export const DEFAULT_MAX_ENTRIES = 50;

interface PendingLoad<S> {
  promise: Promise<S | null>;
  /** Set by `invalidate`: the result may describe data that has since changed, so it is not kept. */
  stale: boolean;
}

/**
 * The in-memory cache of graph snapshots, one per graph, loaded on first use.
 *
 *  - Readers that arrive while a snapshot is loading share that one load.
 *  - `invalidate` (called after a write has committed) drops the entry and marks any load in
 *    flight as stale: its result still goes to the readers already waiting for it, but is never
 *    cached, and later readers start a fresh load. So a slow load that began before a write can
 *    never overwrite the newer snapshot.
 *  - A graph that does not exist (`null`) and a failed load are never cached.
 *  - Least-recently-used snapshots are evicted past `maxEntries`.
 *
 * Meant for a single server instance, where every write goes through the same process.
 */
export class GraphStore<S> {
  private readonly entries = new Map<string, S>(); // insertion order = recency, oldest first
  private readonly pending = new Map<string, PendingLoad<S>>();
  /** Most snapshots kept in memory at once. */
  readonly maxEntries: number;

  constructor(
    private readonly load: SnapshotLoader<S>,
    { maxEntries = DEFAULT_MAX_ENTRIES }: GraphStoreOptions = {},
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The snapshot for a graph, or null if there is no such graph. */
  get(graphId: string): Promise<S | null> {
    const cached = this.entries.get(graphId);
    if (cached !== undefined) {
      this.entries.delete(graphId); // move to the most recent end
      this.entries.set(graphId, cached);
      return Promise.resolve(cached);
    }

    const inFlight = this.pending.get(graphId);
    if (inFlight) return inFlight.promise;

    const load: PendingLoad<S> = { stale: false, promise: undefined as unknown as Promise<S | null> };
    load.promise = this.load(graphId).then(
      (snapshot) => {
        if (this.pending.get(graphId) === load) this.pending.delete(graphId);
        if (snapshot !== null && !load.stale) this.remember(graphId, snapshot);
        return snapshot;
      },
      (error: unknown) => {
        if (this.pending.get(graphId) === load) this.pending.delete(graphId);
        throw error;
      },
    );
    this.pending.set(graphId, load);
    return load.promise;
  }

  /** Forgets a graph. Call it after a write to that graph has committed. */
  invalidate(graphId: string): void {
    this.entries.delete(graphId);
    const inFlight = this.pending.get(graphId);
    if (inFlight) {
      inFlight.stale = true;
      this.pending.delete(graphId);
    }
  }

  clear(): void {
    this.entries.clear();
    for (const inFlight of this.pending.values()) inFlight.stale = true;
    this.pending.clear();
  }

  private remember(graphId: string, snapshot: S): void {
    this.entries.set(graphId, snapshot);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
