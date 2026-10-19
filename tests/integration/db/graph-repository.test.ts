import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { PrismaGraphRepository } from '../../../src/modules/graphs/prisma-graph.repository';
import { createPrismaUnitOfWork } from '../../../src/modules/unit-of-work';
import { edge, sampleGraph, sampleGraphData, serviceNode } from '../../helpers/builders';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('PrismaGraphRepository', () => {
  let prisma: PrismaClient;
  let graphs: PrismaGraphRepository;

  beforeAll(() => {
    prisma = createTestPrisma();
    graphs = new PrismaGraphRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  describe('create and read back', () => {
    it('returns a summary with version 1 and the counts', async () => {
      const summary = await graphs.create(sampleGraph('train'));

      expect(summary).toMatchObject({ name: 'train', version: 1, nodeCount: 4, edgeCount: 4 });
      expect(summary.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(summary.createdAt).toBeInstanceOf(Date);
    });

    it('stores every field and returns nodes in file order', async () => {
      const { id } = await graphs.create(sampleGraph());

      const stored = await graphs.findWithData(id);

      expect(stored?.nodes.map((n) => n.name)).toEqual(['web', 'api', 'db', 'ghost']);
      expect(stored?.nodes).toEqual(sampleGraphData().nodes);
    });

    it('returns edges sorted by source then target, including the self-loop', async () => {
      const { id } = await graphs.create(sampleGraph());

      const stored = await graphs.findWithData(id);

      expect(stored?.edges).toEqual([edge('api', 'api'), edge('api', 'db'), edge('api', 'ghost'), edge('web', 'api')]);
    });

    it('distinguishes SQL NULL from empty values', async () => {
      const { id } = await graphs.create({
        name: 'nulls',
        nodes: [serviceNode('a', { metadata: {}, extra: {}, publicExposed: false }), serviceNode('b')],
        edges: [],
      });

      const [a, b] = (await graphs.findWithData(id))!.nodes;

      expect(a).toMatchObject({ metadata: {}, extra: {}, publicExposed: false });
      expect(b).toMatchObject({ metadata: null, extra: null, publicExposed: null });
    });

    it('keeps a node order that differs from alphabetical order', async () => {
      const { id } = await graphs.create({
        name: 'order',
        nodes: ['zeta', 'alpha', 'mid'].map((n) => serviceNode(n)),
        edges: [],
      });

      expect((await graphs.findWithData(id))!.nodes.map((n) => n.name)).toEqual(['zeta', 'alpha', 'mid']);
    });

    it('stores a graph without nodes or edges', async () => {
      const { id } = await graphs.create({ name: 'empty', nodes: [], edges: [] });

      expect(await graphs.findWithData(id)).toMatchObject({ nodes: [], edges: [], version: 1 });
    });

    it('returns null for an unknown graph', async () => {
      expect(await graphs.findSummary(UNKNOWN_ID)).toBeNull();
      expect(await graphs.findWithData(UNKNOWN_ID)).toBeNull();
    });

    it('rejects an edge to a node that is not in the graph', async () => {
      await expect(
        graphs.create({ name: 'bad', nodes: [serviceNode('a')], edges: [edge('a', 'nowhere')] }),
      ).rejects.toThrow();
    });

    it('inserts many rows across several batches', async () => {
      const nodeCount = 4_500; // more than two batches of 2,000 nodes
      const edgeCount = 25_000; // more than two batches of 10,000 edges
      const nodes = Array.from({ length: nodeCount }, (_, i) => serviceNode(`n${i}`));
      const edges = Array.from({ length: edgeCount }, (_, i) => edge(`n${i % nodeCount}`, `n${(i * 7 + 1 + Math.floor(i / nodeCount)) % nodeCount}`));
      const unique = [...new Map(edges.map((e) => [`${e.from}>${e.to}`, e])).values()];

      const summary = await graphs.create({ name: 'big', nodes, edges: unique });
      const stored = await graphs.findWithData(summary.id);

      expect(summary).toMatchObject({ nodeCount, edgeCount: unique.length });
      expect(stored?.nodes).toHaveLength(nodeCount);
      expect(stored?.edges).toHaveLength(unique.length);
      expect(stored?.nodes[0]?.name).toBe('n0');
      expect(stored?.nodes[nodeCount - 1]?.name).toBe(`n${nodeCount - 1}`);
    }, 60_000);
  });

  describe('list and findSummary', () => {
    it('is empty when there are no graphs', async () => {
      expect(await graphs.list()).toEqual([]);
    });

    it('lists graphs newest first with their counts, without content', async () => {
      const first = await graphs.create(sampleGraph('first'));
      const second = await graphs.create({ name: 'second', nodes: [serviceNode('only')], edges: [] });

      const list = await graphs.list();

      expect(list.map((g) => g.id)).toEqual([second.id, first.id]);
      expect(list[0]).toMatchObject({ name: 'second', nodeCount: 1, edgeCount: 0 });
      expect(list[1]).toMatchObject({ name: 'first', nodeCount: 4, edgeCount: 4 });
      expect(list[0]).not.toHaveProperty('nodes');
    });

    it('finds one summary by id', async () => {
      const { id } = await graphs.create(sampleGraph('one'));

      expect(await graphs.findSummary(id)).toMatchObject({ id, name: 'one', nodeCount: 4, edgeCount: 4 });
    });
  });

  describe('rename', () => {
    it('changes the name and updated_at but not the version or content', async () => {
      const created = await graphs.create(sampleGraph('before'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const renamed = await graphs.rename(created.id, 'after');

      expect(renamed).toMatchObject({ id: created.id, name: 'after', version: 1, nodeCount: 4, edgeCount: 4 });
      expect(renamed.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      expect(renamed.createdAt).toEqual(created.createdAt);
    });

    it('throws NotFoundError for an unknown graph', async () => {
      await expect(graphs.rename(UNKNOWN_ID, 'x')).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
    });

    it('is refused by the database for a blank name', async () => {
      const { id } = await graphs.create(sampleGraph());

      await expect(graphs.rename(id, '   ')).rejects.toThrow(/graphs_name_length_check/);
    });
  });

  describe('delete', () => {
    it('removes the graph, its nodes and its edges but leaves other graphs alone', async () => {
      const doomed = await graphs.create(sampleGraph('doomed'));
      const kept = await graphs.create(sampleGraph('kept'));

      await graphs.delete(doomed.id);

      expect(await graphs.findSummary(doomed.id)).toBeNull();
      expect(await prisma.node.count({ where: { graphId: doomed.id } })).toBe(0);
      expect(await prisma.edge.count({ where: { graphId: doomed.id } })).toBe(0);
      expect(await graphs.findSummary(kept.id)).toMatchObject({ nodeCount: 4, edgeCount: 4 });
    });

    it('throws NotFoundError for an unknown graph', async () => {
      await expect(graphs.delete(UNKNOWN_ID)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
    });
  });

  describe('bumpVersion', () => {
    it('increments the version each time and returns the new value', async () => {
      const { id } = await graphs.create(sampleGraph());

      expect(await graphs.bumpVersion(id)).toBe(2);
      expect(await graphs.bumpVersion(id)).toBe(3);
      expect((await graphs.findSummary(id))?.version).toBe(3);
    });

    it('bumps when the expected version matches', async () => {
      const { id } = await graphs.create(sampleGraph());

      expect(await graphs.bumpVersion(id, 1)).toBe(2);
    });

    it('throws VERSION_CONFLICT for a stale expected version and changes nothing', async () => {
      const { id } = await graphs.create(sampleGraph());
      await graphs.bumpVersion(id);

      await expect(graphs.bumpVersion(id, 1)).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      expect((await graphs.findSummary(id))?.version).toBe(2);
    });

    it('throws VERSION_CONFLICT for an expected version from the future', async () => {
      const { id } = await graphs.create(sampleGraph());

      await expect(graphs.bumpVersion(id, 5)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('throws NotFoundError for an unknown graph, with or without an expected version', async () => {
      await expect(graphs.bumpVersion(UNKNOWN_ID)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
      await expect(graphs.bumpVersion(UNKNOWN_ID, 1)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
    });
  });

  describe('replaceData', () => {
    it('swaps all nodes and edges and leaves name and version to the caller', async () => {
      const { id } = await graphs.create(sampleGraph('keep-name'));

      await graphs.replaceData(id, {
        nodes: [serviceNode('x'), serviceNode('y')],
        edges: [edge('x', 'y')],
      });

      const stored = await graphs.findWithData(id);
      expect(stored).toMatchObject({ name: 'keep-name', version: 1 });
      expect(stored?.nodes.map((n) => n.name)).toEqual(['x', 'y']);
      expect(stored?.edges).toEqual([edge('x', 'y')]);
      expect(await prisma.node.count()).toBe(2);
      expect(await prisma.edge.count()).toBe(1);
    });

    it('does not touch other graphs', async () => {
      const target = await graphs.create(sampleGraph('target'));
      const other = await graphs.create(sampleGraph('other'));

      await graphs.replaceData(target.id, { nodes: [], edges: [] });

      expect(await graphs.findSummary(other.id)).toMatchObject({ nodeCount: 4, edgeCount: 4 });
    });
  });

  describe('reading inside a transaction', () => {
    it('works with the transaction-bound repository', async () => {
      const { id } = await graphs.create(sampleGraph());
      const unitOfWork = createPrismaUnitOfWork(prisma);

      const stored = await unitOfWork.run(({ graphs: txGraphs }) => txGraphs.findWithData(id));

      expect(stored?.nodes).toHaveLength(4);
    });
  });
});
