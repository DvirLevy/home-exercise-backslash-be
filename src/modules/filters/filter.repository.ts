import type { FilterChanges, FilterRecord, NewFilter } from './filter.types';

/**
 * Persistence for per-graph filter definitions. Changing a filter changes query results, so the
 * caller must also bump the graph version in the same transaction (see GraphRepository.bumpVersion).
 */
export interface FilterRepository {
  /** Built-in filters first, then custom ones, each group ordered by key. */
  list(graphId: string): Promise<FilterRecord[]>;

  findByKey(graphId: string, key: string): Promise<FilterRecord | null>;

  /** Throws ConflictError('FILTER_KEY_EXISTS') for a duplicate key and NotFoundError for an unknown graph. */
  create(graphId: string, filter: NewFilter): Promise<FilterRecord>;

  /** Same errors as `create`. All-or-nothing when run inside a transaction. */
  createMany(graphId: string, filters: NewFilter[]): Promise<void>;

  /** Throws NotFoundError('FILTER_NOT_FOUND'). */
  update(graphId: string, key: string, changes: FilterChanges): Promise<FilterRecord>;

  /** Throws NotFoundError('FILTER_NOT_FOUND'). */
  delete(graphId: string, key: string): Promise<void>;
}
