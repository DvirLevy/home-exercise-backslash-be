import type { GraphStore } from '../../graph-engine/graph-store';
import { ConflictError, NotFoundError } from '../../http/errors';
import type { JsonValue } from '../../shared/json';
import type { GraphCache } from '../graphs/graph-cache';
import type { LoadedGraph } from '../queries/loaded-graph';
import type { UnitOfWork } from '../unit-of-work';
import { MAX_FILTERS_PER_GRAPH, type FilterRecord } from './filter.types';
import { compileRule } from './rules/rule.compiler';
import { parseRule } from './rules/rule.schema';

/** A stored filter together with how many nodes of the graph it matches right now. */
export interface FilterView {
  record: FilterRecord;
  /** null when the stored rule can no longer be compiled. */
  matchCount: number | null;
}

export interface FilterPreview {
  matchCount: number;
  matches: string[];
}

export interface FilterInput {
  /** Free text or empty; empty becomes "no description". */
  description?: string | null | undefined;
  /** The rule, exactly as sent; validated here. */
  definition: unknown;
}

const graphNotFound = () => new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND');
const filterNotFound = () => new NotFoundError('Filter not found', 'FILTER_NOT_FOUND');
const builtinReadOnly = () =>
  new ConflictError('Built-in filters are read-only and cannot be changed or deleted', 'BUILTIN_FILTER_READ_ONLY');

/**
 * Filter definitions of a graph. Reads come from the in-memory snapshot (so counts and rules
 * describe the same moment); every write goes through PostgreSQL, bumps the graph version in the
 * same transaction, and drops the cache entry only after the commit.
 */
export class FilterService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: GraphStore<LoadedGraph>,
    private readonly cache: GraphCache,
  ) {}

  async list(graphId: string): Promise<FilterView[]> {
    const loaded = await this.load(graphId);
    return loaded.filters.map((record) => viewOf(loaded, record));
  }

  async get(graphId: string, key: string): Promise<FilterView> {
    const loaded = await this.load(graphId);
    const record = loaded.filters.find((filter) => filter.key === key);
    if (!record) throw filterNotFound();
    return viewOf(loaded, record);
  }

  async create(graphId: string, key: string, input: FilterInput): Promise<FilterView> {
    const definition = parseRule(input.definition) as unknown as JsonValue;

    await this.unitOfWork.run(async ({ graphs, filters }) => {
      await graphs.bumpVersion(graphId); // first: locks the graph, 404 if it does not exist
      if ((await filters.list(graphId)).length >= MAX_FILTERS_PER_GRAPH) {
        throw new ConflictError(
          `A graph can have at most ${MAX_FILTERS_PER_GRAPH} filters, built-in ones included`,
          'FILTER_LIMIT_REACHED',
        );
      }
      await filters.create(graphId, { key, description: normalizeDescription(input.description), definition, isBuiltin: false });
    });
    this.cache.invalidate(graphId);
    return this.get(graphId, key);
  }

  async replace(graphId: string, key: string, input: FilterInput): Promise<FilterView> {
    const definition = parseRule(input.definition) as unknown as JsonValue;

    await this.unitOfWork.run(async ({ graphs, filters }) => {
      await graphs.bumpVersion(graphId);
      const existing = await filters.findByKey(graphId, key);
      if (!existing) throw filterNotFound();
      if (existing.isBuiltin) throw builtinReadOnly();
      await filters.update(graphId, key, { description: normalizeDescription(input.description), definition });
    });
    this.cache.invalidate(graphId);
    return this.get(graphId, key);
  }

  async delete(graphId: string, key: string): Promise<void> {
    await this.unitOfWork.run(async ({ graphs, filters }) => {
      await graphs.bumpVersion(graphId);
      const existing = await filters.findByKey(graphId, key);
      if (!existing) throw filterNotFound();
      if (existing.isBuiltin) throw builtinReadOnly();
      await filters.delete(graphId, key);
    });
    this.cache.invalidate(graphId);
  }

  /** Which nodes a rule would match. Reads only: nothing is stored and the version is untouched. */
  async preview(graphId: string, rawDefinition: unknown): Promise<FilterPreview> {
    const predicate = compileRule(parseRule(rawDefinition));
    const { snapshot } = await this.load(graphId);

    const matches: string[] = [];
    for (const node of snapshot.nodes.values()) {
      if (!node.isPlaceholder && predicate(node)) matches.push(node.name);
    }
    return { matchCount: matches.length, matches };
  }

  private async load(graphId: string): Promise<LoadedGraph> {
    const loaded = await this.store.get(graphId);
    if (!loaded) throw graphNotFound();
    return loaded;
  }
}

function viewOf(loaded: LoadedGraph, record: FilterRecord): FilterView {
  return { record, matchCount: loaded.snapshot.filterIndex.get(record.key)?.size ?? null };
}

function normalizeDescription(description: string | null | undefined): string | null {
  return description ? description : null;
}
