import type { FilterRepository } from '../../src/modules/filters/filter.repository';
import type { GraphCache } from '../../src/modules/graphs/graph-cache';
import type { GraphRepository } from '../../src/modules/graphs/graph.repository';
import type { GraphSummary } from '../../src/modules/graphs/graph.types';
import type { TransactionalRepositories, UnitOfWork } from '../../src/modules/unit-of-work';

export function summaryOf(overrides: Partial<GraphSummary> = {}): GraphSummary {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'graph',
    version: 1,
    nodeCount: 0,
    edgeCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Every method is a jest mock returning a sensible default; override per test. */
export function fakeGraphRepository(overrides: Partial<jest.Mocked<GraphRepository>> = {}): jest.Mocked<GraphRepository> {
  const defaults: GraphRepository = {
    create: async ({ name, nodes, edges }) => summaryOf({ name, nodeCount: nodes.length, edgeCount: edges.length }),
    list: async () => [],
    findSummary: async () => summaryOf(),
    findWithData: async () => null,
    rename: async (_id, name) => summaryOf({ name }),
    bumpVersion: async () => 2,
    replaceData: async () => undefined,
    delete: async () => undefined,
  };
  const mocked = Object.fromEntries(
    Object.entries(defaults).map(([method, implementation]) => [method, jest.fn(implementation)]),
  ) as unknown as jest.Mocked<GraphRepository>;
  return Object.assign(mocked, overrides);
}

export function fakeFilterRepository(overrides: Partial<jest.Mocked<FilterRepository>> = {}): jest.Mocked<FilterRepository> {
  const defaults: FilterRepository = {
    list: async () => [],
    findByKey: async () => null,
    create: async () => {
      throw new Error('create is not stubbed');
    },
    createMany: async () => undefined,
    update: async () => {
      throw new Error('update is not stubbed');
    },
    delete: async () => undefined,
  };
  const mocked = Object.fromEntries(
    Object.entries(defaults).map(([method, implementation]) => [method, jest.fn(implementation)]),
  ) as unknown as jest.Mocked<FilterRepository>;
  return Object.assign(mocked, overrides);
}

export interface FakeUnitOfWork extends UnitOfWork {
  /** Repositories handed to transactional work (distinct from the plain ones a service holds). */
  tx: { graphs: jest.Mocked<GraphRepository>; filters: jest.Mocked<FilterRepository> };
  run: jest.Mock;
  /** True once a unit of work finished without throwing. */
  committed: boolean;
}

/** Runs the work immediately; "commits" only if the work did not throw. */
export function fakeUnitOfWork(tx: Partial<TransactionalRepositories> = {}): FakeUnitOfWork {
  const repositories = {
    graphs: (tx.graphs as jest.Mocked<GraphRepository>) ?? fakeGraphRepository(),
    filters: (tx.filters as jest.Mocked<FilterRepository>) ?? fakeFilterRepository(),
  };
  const unitOfWork: FakeUnitOfWork = {
    tx: repositories,
    committed: false,
    run: jest.fn(async (work: (repos: TransactionalRepositories) => Promise<unknown>) => {
      const result = await work(repositories);
      unitOfWork.committed = true;
      return result;
    }),
  };
  return unitOfWork;
}

/** Records whether the surrounding unit of work had committed at the moment of each invalidation. */
export function recordingCache(unitOfWork: FakeUnitOfWork): GraphCache & { calls: Array<{ id: string; afterCommit: boolean }> } {
  const calls: Array<{ id: string; afterCommit: boolean }> = [];
  return { calls, invalidate: (id) => void calls.push({ id, afterCommit: unitOfWork.committed }) };
}
