import { NotFoundError } from '../../http/errors';
import { BUILTIN_FILTERS } from '../filters/builtin-filters';
import type { UnitOfWork } from '../unit-of-work';
import type { GraphCache } from './graph-cache';
import type { GraphRepository } from './graph.repository';
import type { GraphSummary, StoredGraph } from './graph.types';
import { parseGraphFile } from './ingestion/graph-file.schema';
import { normalizeGraph, type GraphLimits, type NormalizedGraph } from './ingestion/graph-normalizer';

export interface GraphWriteResult {
  summary: GraphSummary;
  /** Nodes that edges referenced but the file did not define. */
  placeholders: string[];
}

export interface ReplaceGraphInput {
  /** Parsed JSON content of the uploaded file. */
  content: unknown;
  /** New name; the current one is kept when omitted. */
  name?: string | undefined;
  /** Version the client last saw (`If-Match`). A mismatch means someone else changed the graph. */
  expectedVersion?: number | undefined;
}

function graphNotFound(): NotFoundError {
  return new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND');
}

export class GraphService {
  constructor(
    private readonly graphs: GraphRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly cache: GraphCache,
    private readonly limits: GraphLimits,
  ) {}

  /** Stores a new graph together with its built-in filters, atomically. */
  async create(name: string, content: unknown): Promise<GraphWriteResult> {
    const normalized = this.prepare(content);

    const summary = await this.unitOfWork.run(async ({ graphs, filters }) => {
      const created = await graphs.create({
        name,
        extra: normalized.extra,
        nodes: normalized.nodes,
        edges: normalized.edges,
      });
      await filters.createMany(created.id, [...BUILTIN_FILTERS]);
      return created;
    });
    return { summary, placeholders: normalized.placeholders };
  }

  list(): Promise<GraphSummary[]> {
    return this.graphs.list();
  }

  async get(id: string): Promise<StoredGraph> {
    const graph = await this.graphs.findWithData(id);
    if (!graph) throw graphNotFound();
    return graph;
  }

  /**
   * Replaces a graph's nodes and edges. The file is validated before any transaction opens, so a
   * bad upload never takes a lock. Custom and built-in filters are kept.
   */
  async replace(id: string, { content, name, expectedVersion }: ReplaceGraphInput): Promise<GraphWriteResult> {
    const normalized = this.prepare(content);

    const summary = await this.unitOfWork.run(async ({ graphs }) => {
      // First statement: locks the row, checks If-Match and bumps the version.
      await graphs.bumpVersion(id, expectedVersion);
      await graphs.replaceData(id, { extra: normalized.extra, nodes: normalized.nodes, edges: normalized.edges });

      const current = name === undefined ? await graphs.findSummary(id) : await graphs.rename(id, name);
      if (!current) throw graphNotFound();
      return current;
    });

    // Only after the commit: a rolled-back write must not evict a cache entry that is still correct.
    this.cache.invalidate(id);
    return { summary, placeholders: normalized.placeholders };
  }

  /** Renaming does not change query results, so the version and the cache are left alone. */
  rename(id: string, name: string): Promise<GraphSummary> {
    return this.graphs.rename(id, name);
  }

  async delete(id: string): Promise<void> {
    await this.graphs.delete(id);
    this.cache.invalidate(id);
  }

  private prepare(content: unknown): NormalizedGraph {
    return normalizeGraph(parseGraphFile(content), this.limits);
  }
}
