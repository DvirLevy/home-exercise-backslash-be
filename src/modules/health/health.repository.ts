export interface HealthRepository {
  /** Resolves when the database answers a trivial query, rejects otherwise. */
  ping(): Promise<void>;
}
