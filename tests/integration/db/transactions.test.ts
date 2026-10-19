import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { ConflictError } from '../../../src/http/errors';
import { PrismaFilterRepository } from '../../../src/modules/filters/prisma-filter.repository';
import type { GraphData } from '../../../src/modules/graphs/graph.types';
import { PrismaGraphRepository } from '../../../src/modules/graphs/prisma-graph.repository';
import { createPrismaUnitOfWork, type UnitOfWork } from '../../../src/modules/unit-of-work';
import { builtinFilters, edge, sampleGraph, sampleGraphData, serviceNode } from '../../helpers/builders';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function dataNamed(...names: string[]): GraphData {
  return { nodes: names.map((n) => serviceNode(n)), edges: names.slice(1).map((n, i) => edge(names[i]!, n)) };
}

describe('transactions and optimistic locking', () => {
  let prisma: PrismaClient;
  let graphs: PrismaGraphRepository;
  let filters: PrismaFilterRepository;
  let unitOfWork: UnitOfWork;
  let graphId: string;

  /** The write path the services will use: lock and bump first, then change the data. */
  const replace = (data: GraphData, expectedVersion?: number, afterWrite?: () => Promise<void>) =>
    unitOfWork.run(async (repos) => {
      const version = await repos.graphs.bumpVersion(graphId, expectedVersion);
      await repos.graphs.replaceData(graphId, data);
      await afterWrite?.();
      return version;
    });

  beforeAll(() => {
    prisma = createTestPrisma();
    graphs = new PrismaGraphRepository(prisma);
    filters = new PrismaFilterRepository(prisma);
    unitOfWork = createPrismaUnitOfWork(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    graphId = (await graphs.create(sampleGraph())).id;
  });

  describe('commit and rollback', () => {
    it('commits a graph together with its built-in filters', async () => {
      const id = await unitOfWork.run(async (repos) => {
        const summary = await repos.graphs.create(sampleGraph('with-filters'));
        await repos.filters.createMany(summary.id, builtinFilters());
        return summary.id;
      });

      expect(await graphs.findSummary(id)).toMatchObject({ name: 'with-filters' });
      expect(await filters.list(id)).toHaveLength(3);
    });

    it('rolls everything back when the callback throws after writing', async () => {
      await expect(
        unitOfWork.run(async (repos) => {
          const summary = await repos.graphs.create(sampleGraph('doomed'));
          await repos.filters.createMany(summary.id, builtinFilters());
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect((await graphs.list()).map((g) => g.name)).toEqual(['sample']);
      expect(await prisma.graphFilter.count()).toBe(0);
    });

    it('rolls back the graph when its filters cannot be stored', async () => {
      await expect(
        unitOfWork.run(async (repos) => {
          const summary = await repos.graphs.create(sampleGraph('half-written'));
          await repos.filters.createMany(summary.id, [...builtinFilters(), ...builtinFilters()]);
        }),
      ).rejects.toMatchObject({ code: 'FILTER_KEY_EXISTS' });

      expect((await graphs.list()).map((g) => g.name)).toEqual(['sample']);
    });
  });

  describe('atomic replace', () => {
    it('replaces the data and bumps the version in one step', async () => {
      const version = await replace(dataNamed('x', 'y', 'z'));

      expect(version).toBe(2);
      const stored = await graphs.findWithData(graphId);
      expect(stored?.version).toBe(2);
      expect(stored?.nodes.map((n) => n.name)).toEqual(['x', 'y', 'z']);
      expect(stored?.edges).toEqual([edge('x', 'y'), edge('y', 'z')]);
    });

    it('leaves the old data and the old version when the replace fails partway', async () => {
      const broken: GraphData = { nodes: [serviceNode('only')], edges: [edge('only', 'missing')] };

      await expect(replace(broken)).rejects.toThrow();

      const stored = await graphs.findWithData(graphId);
      expect(stored?.version).toBe(1);
      expect(stored?.nodes).toEqual(sampleGraphData().nodes);
      expect(stored?.edges).toHaveLength(4);
    });

    it('leaves the old data when the callback throws after the replace succeeded', async () => {
      await expect(
        replace(dataNamed('x'), undefined, async () => {
          throw new Error('late failure');
        }),
      ).rejects.toThrow('late failure');

      const stored = await graphs.findWithData(graphId);
      expect(stored?.version).toBe(1);
      expect(stored?.nodes).toHaveLength(4);
    });

    it('keeps the filters when the data is replaced', async () => {
      await filters.createMany(graphId, builtinFilters());

      await replace(dataNamed('x'));

      expect(await filters.list(graphId)).toHaveLength(3);
    });
  });

  describe('If-Match semantics', () => {
    it('accepts the current version', async () => {
      await expect(replace(dataNamed('x'), 1)).resolves.toBe(2);
    });

    it('refuses a stale version with VERSION_CONFLICT and changes nothing', async () => {
      await replace(dataNamed('first'));

      const attempt = replace(dataNamed('second'), 1);

      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
      await expect(attempt).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      const stored = await graphs.findWithData(graphId);
      expect(stored?.version).toBe(2);
      expect(stored?.nodes.map((n) => n.name)).toEqual(['first']);
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two concurrent replaces with the same expected version win', async () => {
      // Each writer pauses after writing, so the two transactions genuinely overlap.
      const hold = () => sleep(100);

      const results = await Promise.allSettled([
        replace(dataNamed('a1', 'a2'), 1, hold),
        replace(dataNamed('b1', 'b2', 'b3'), 1, hold),
      ]);

      const winners = results.filter((r) => r.status === 'fulfilled');
      const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.reason).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });

      const stored = await graphs.findWithData(graphId);
      expect(stored?.version).toBe(2);
      const winnerIsA = stored?.nodes[0]?.name === 'a1';
      expect(stored?.nodes.map((n) => n.name)).toEqual(winnerIsA ? ['a1', 'a2'] : ['b1', 'b2', 'b3']);
      expect(stored?.edges).toHaveLength(winnerIsA ? 1 : 2);
    });

    it('serialises writers without an expected version and never loses a bump', async () => {
      const hold = () => sleep(50);

      const versions = await Promise.all([
        replace(dataNamed('a'), undefined, hold),
        replace(dataNamed('b'), undefined, hold),
        replace(dataNamed('c'), undefined, hold),
      ]);

      expect([...versions].sort()).toEqual([2, 3, 4]);
      expect((await graphs.findSummary(graphId))?.version).toBe(4);
    });

    it('lets readers see the last committed data, never a half-written replace', async () => {
      let readDuringWrite: Awaited<ReturnType<PrismaGraphRepository['findWithData']>> = null;

      await replace(dataNamed('new1', 'new2'), 1, async () => {
        // The write transaction is still open here; a reader on another connection sees version 1.
        readDuringWrite = await graphs.findWithData(graphId);
      });

      expect(readDuringWrite).toMatchObject({ version: 1 });
      expect((readDuringWrite as unknown as { nodes: unknown[] }).nodes).toHaveLength(4);
      expect((await graphs.findWithData(graphId))?.version).toBe(2);
    });

    it('blocks a delete behind an open write transaction instead of corrupting it', async () => {
      const order: string[] = [];

      const writer = replace(dataNamed('x'), undefined, async () => {
        await sleep(100);
        order.push('writer-done');
      });
      await sleep(20);
      const deleter = unitOfWork
        .run(async (repos) => {
          await repos.graphs.bumpVersion(graphId); // waits for the writer's row lock
          order.push('deleter-got-lock');
          await repos.graphs.delete(graphId);
        });

      await Promise.all([writer, deleter]);

      expect(order).toEqual(['writer-done', 'deleter-got-lock']);
      expect(await graphs.findSummary(graphId)).toBeNull();
    });
  });
});
