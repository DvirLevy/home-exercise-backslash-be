import type { GraphFilter } from '../../generated/prisma/client';
import { ConflictError, NotFoundError } from '../../http/errors';
import { Prisma, type DbClient } from '../../infrastructure/prisma';
import type { JsonValue } from '../../shared/json';
import type { FilterRepository } from './filter.repository';
import { CURRENT_DEFINITION_VERSION, type FilterChanges, type FilterRecord, type NewFilter } from './filter.types';

function toFilterRecord(row: GraphFilter): FilterRecord {
  return {
    id: row.id,
    graphId: row.graphId,
    key: row.key,
    description: row.description,
    definition: row.definition as JsonValue,
    definitionVersion: row.definitionVersion,
    isBuiltin: row.isBuiltin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCreateInput(graphId: string, filter: NewFilter): Prisma.GraphFilterCreateManyInput {
  return {
    graphId,
    key: filter.key,
    description: filter.description,
    definition: filter.definition as Prisma.InputJsonValue,
    definitionVersion: CURRENT_DEFINITION_VERSION,
    isBuiltin: filter.isBuiltin,
  };
}

function isKnownError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

/** Unique violation -> duplicate key; foreign key violation -> the graph does not exist. */
function translateWriteError(err: unknown): unknown {
  if (isKnownError(err, 'P2002')) {
    return new ConflictError('A filter with this key already exists in the graph', 'FILTER_KEY_EXISTS');
  }
  if (isKnownError(err, 'P2003')) {
    return new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND');
  }
  return err;
}

function filterNotFound(): NotFoundError {
  return new NotFoundError('Filter not found', 'FILTER_NOT_FOUND');
}

export class PrismaFilterRepository implements FilterRepository {
  constructor(private readonly db: DbClient) {}

  async list(graphId: string): Promise<FilterRecord[]> {
    const rows = await this.db.graphFilter.findMany({
      where: { graphId },
      orderBy: [{ isBuiltin: 'desc' }, { key: 'asc' }],
    });
    return rows.map(toFilterRecord);
  }

  async findByKey(graphId: string, key: string): Promise<FilterRecord | null> {
    const row = await this.db.graphFilter.findUnique({ where: { graphId_key: { graphId, key } } });
    return row ? toFilterRecord(row) : null;
  }

  async create(graphId: string, filter: NewFilter): Promise<FilterRecord> {
    try {
      const row = await this.db.graphFilter.create({ data: toCreateInput(graphId, filter) });
      return toFilterRecord(row);
    } catch (err) {
      throw translateWriteError(err);
    }
  }

  async createMany(graphId: string, filters: NewFilter[]): Promise<void> {
    try {
      await this.db.graphFilter.createMany({ data: filters.map((filter) => toCreateInput(graphId, filter)) });
    } catch (err) {
      throw translateWriteError(err);
    }
  }

  async update(graphId: string, key: string, changes: FilterChanges): Promise<FilterRecord> {
    try {
      const row = await this.db.graphFilter.update({
        where: { graphId_key: { graphId, key } },
        data: {
          description: changes.description,
          definition: changes.definition as Prisma.InputJsonValue,
          definitionVersion: CURRENT_DEFINITION_VERSION,
        },
      });
      return toFilterRecord(row);
    } catch (err) {
      if (isKnownError(err, 'P2025')) throw filterNotFound();
      throw err;
    }
  }

  async delete(graphId: string, key: string): Promise<void> {
    try {
      await this.db.graphFilter.delete({ where: { graphId_key: { graphId, key } } });
    } catch (err) {
      if (isKnownError(err, 'P2025')) throw filterNotFound();
      throw err;
    }
  }
}
