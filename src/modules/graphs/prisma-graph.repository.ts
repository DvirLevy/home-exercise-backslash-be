import { ConflictError, NotFoundError } from '../../http/errors';
import type { JsonObject } from '../../shared/json';
import { Prisma, type DbClient, type PrismaClient } from '../../infrastructure/prisma';
import type { GraphRepository } from './graph.repository';
import {
  nullableJson,
  toEdgeCreateInput,
  toEdgeRecord,
  toGraphSummary,
  toNodeCreateInput,
  toNodeRecord,
} from './graph.mapper';
import type { GraphData, GraphSummary, NewGraph, StoredGraph } from './graph.types';

// PostgreSQL allows 65,535 bind parameters per statement. Nodes have 11 columns and edges 3,
// so these batch sizes stay safely below the limit.
const NODE_BATCH_SIZE = 2_000;
const EDGE_BATCH_SIZE = 10_000;

const WITH_COUNTS = { _count: { select: { nodes: true, edges: true } } } as const;

function graphNotFound(): NotFoundError {
  return new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND');
}

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** Only the root client can open a transaction; the one handed to a transaction callback cannot. */
function isRootClient(db: DbClient): db is PrismaClient {
  return '$transaction' in db;
}

function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

export class PrismaGraphRepository implements GraphRepository {
  constructor(private readonly db: DbClient) {}

  async create({ name, extra, nodes, edges }: NewGraph): Promise<GraphSummary> {
    const graph = await this.db.graph.create({ data: { name, extra: nullableJson(extra) } });
    await this.insertData(graph.id, { nodes, edges });
    return {
      id: graph.id,
      name: graph.name,
      version: graph.version,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
    };
  }

  async list(): Promise<GraphSummary[]> {
    const graphs = await this.db.graph.findMany({
      include: WITH_COUNTS,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return graphs.map(toGraphSummary);
  }

  async findSummary(id: string): Promise<GraphSummary | null> {
    const graph = await this.db.graph.findUnique({ where: { id }, include: WITH_COUNTS });
    return graph ? toGraphSummary(graph) : null;
  }

  async findWithData(id: string): Promise<StoredGraph | null> {
    // Three queries must see the same version of the data, otherwise a replace that commits in
    // between could yield a graph row from one version with nodes from another.
    if (isRootClient(this.db)) {
      return this.db.$transaction((tx) => new PrismaGraphRepository(tx).readData(id), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
    }
    // Already inside a transaction, which provides its own snapshot.
    return this.readData(id);
  }

  async rename(id: string, name: string): Promise<GraphSummary> {
    try {
      const graph = await this.db.graph.update({ where: { id }, data: { name }, include: WITH_COUNTS });
      return toGraphSummary(graph);
    } catch (err) {
      if (isRecordNotFound(err)) throw graphNotFound();
      throw err;
    }
  }

  async bumpVersion(id: string, expectedVersion?: number): Promise<number> {
    const versionGuard =
      expectedVersion === undefined ? Prisma.empty : Prisma.sql`AND "version" = ${expectedVersion}`;
    const rows = await this.db.$queryRaw<{ version: number }[]>`
      UPDATE "graphs"
      SET "version" = "version" + 1, "updated_at" = now()
      WHERE "id" = ${id}::uuid ${versionGuard}
      RETURNING "version"`;

    const updated = rows[0];
    if (updated) return updated.version;

    // Nothing was updated: either the graph does not exist or the expected version is stale.
    const current = await this.db.graph.findUnique({ where: { id }, select: { version: true } });
    if (!current) throw graphNotFound();
    throw new ConflictError(
      `Graph was modified by someone else (current version ${current.version}, expected ${expectedVersion})`,
      'VERSION_CONFLICT',
    );
  }

  async replaceData(id: string, data: GraphData): Promise<void> {
    try {
      await this.db.graph.update({ where: { id }, data: { extra: nullableJson(data.extra) } });
    } catch (err) {
      if (isRecordNotFound(err)) throw graphNotFound();
      throw err;
    }
    // Deleting nodes cascades to their edges.
    await this.db.node.deleteMany({ where: { graphId: id } });
    await this.insertData(id, data);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.db.graph.delete({ where: { id } });
    } catch (err) {
      if (isRecordNotFound(err)) throw graphNotFound();
      throw err;
    }
  }

  private async readData(id: string): Promise<StoredGraph | null> {
    const graph = await this.db.graph.findUnique({ where: { id } });
    if (!graph) return null;

    const [nodes, edges] = await Promise.all([
      this.db.node.findMany({ where: { graphId: id }, orderBy: { position: 'asc' } }),
      this.db.edge.findMany({ where: { graphId: id }, orderBy: [{ fromName: 'asc' }, { toName: 'asc' }] }),
    ]);
    return {
      id: graph.id,
      name: graph.name,
      version: graph.version,
      extra: graph.extra as JsonObject | null,
      nodes: nodes.map(toNodeRecord),
      edges: edges.map(toEdgeRecord),
    };
  }

  /** Nodes first, so the edges' foreign keys can resolve. Positions follow the array order. */
  private async insertData(graphId: string, { nodes, edges }: Pick<GraphData, 'nodes' | 'edges'>): Promise<void> {
    let position = 0;
    for (const batch of batches(nodes, NODE_BATCH_SIZE)) {
      await this.db.node.createMany({ data: batch.map((node) => toNodeCreateInput(graphId, node, position++)) });
    }
    for (const batch of batches(edges, EDGE_BATCH_SIZE)) {
      await this.db.edge.createMany({ data: batch.map((edge) => toEdgeCreateInput(graphId, edge)) });
    }
  }
}
