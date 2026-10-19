import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { expectConstraintViolation } from '../../helpers/db-assertions';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

describe('database constraints', () => {
  let prisma: PrismaClient;
  let graphId: string;

  beforeAll(() => {
    prisma = createTestPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    graphId = (await prisma.graph.create({ data: { name: 'g' } })).id;
  });

  const addNode = (name: string, data: Record<string, unknown> = {}) =>
    prisma.node.create({ data: { graphId, name, position: 0, kind: 'service', ...data } });

  describe('graphs', () => {
    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['over 200 characters', 'x'.repeat(201)],
    ])('rejects a name that is %s', async (_label, name) => {
      await expectConstraintViolation(prisma.graph.create({ data: { name } }), 'graphs_name_length_check');
    });

    it('accepts names of 1 and 200 characters, and surrounding spaces', async () => {
      await expect(prisma.graph.create({ data: { name: 'x' } })).resolves.toBeDefined();
      await expect(prisma.graph.create({ data: { name: 'x'.repeat(200) } })).resolves.toBeDefined();
      await expect(prisma.graph.create({ data: { name: '  padded  ' } })).resolves.toBeDefined();
    });

    it.each([0, -1])('rejects version %i', async (version) => {
      await expectConstraintViolation(prisma.graph.create({ data: { name: 'v', version } }), 'graphs_version_check');
    });

    it('starts at version 1 and generates a UUID in the database', async () => {
      const graph = await prisma.graph.create({ data: { name: 'fresh' } });

      expect(graph.version).toBe(1);
      expect(graph.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('nodes', () => {
    it('rejects a duplicate node name within a graph', async () => {
      await addNode('dup');

      await expectConstraintViolation(addNode('dup', { position: 1 }), 'nodes_pkey');
    });

    it('allows the same node name in different graphs', async () => {
      const other = await prisma.graph.create({ data: { name: 'other' } });
      await addNode('shared');

      await expect(
        prisma.node.create({ data: { graphId: other.id, name: 'shared', position: 0, kind: 'service' } }),
      ).resolves.toBeDefined();
    });

    it('rejects an empty node name', async () => {
      await expectConstraintViolation(addNode(''), 'nodes_name_not_empty_check');
    });

    it('rejects a negative position', async () => {
      await expectConstraintViolation(addNode('n', { position: -1 }), 'nodes_position_check');
    });

    it('rejects a node of an unknown graph', async () => {
      await expectConstraintViolation(
        prisma.node.create({
          data: { graphId: '00000000-0000-0000-0000-000000000000', name: 'n', position: 0, kind: 'service' },
        }),
        'nodes_graph_id_fkey',
      );
    });

    it('rejects a real node without a kind', async () => {
      await expectConstraintViolation(addNode('n', { kind: null }), 'nodes_kind_required_check');
    });

    describe('placeholders', () => {
      const placeholder = (data: Record<string, unknown> = {}) => addNode('p', { kind: null, isPlaceholder: true, ...data });

      it('accepts a placeholder that holds only its name', async () => {
        await expect(placeholder()).resolves.toMatchObject({ isPlaceholder: true, kind: null });
      });

      it.each([
        ['kind', { kind: 'service' }],
        ['language', { language: 'java' }],
        ['path', { path: 'x' }],
        ['publicExposed', { publicExposed: false }],
        ['metadata', { metadata: { cloud: 'AWS' } }],
        ['extra', { extra: { a: 1 } }],
        ['vulnerabilities', { vulnerabilities: [{ severity: 'low' }] }],
      ])('rejects a placeholder with %s', async (_field, data) => {
        await expectConstraintViolation(placeholder(data), 'nodes_placeholder_empty_check');
      });
    });

    describe('vulnerabilities', () => {
      it.each([
        ['an object', {}],
        ['a string', 'oops'],
        ['a number', 3],
      ])('rejects %s', async (_label, value) => {
        await expectConstraintViolation(addNode('n', { vulnerabilities: value }), 'nodes_vulnerabilities_array_check');
      });

      it('defaults to an empty array and keeps array content', async () => {
        const plain = await addNode('plain');
        const withItems = await addNode('items', { vulnerabilities: [{ severity: 'high' }] });

        expect(plain.vulnerabilities).toEqual([]);
        expect(withItems.vulnerabilities).toEqual([{ severity: 'high' }]);
      });
    });
  });

  describe('edges', () => {
    const addEdge = (from: string, to: string, onGraph = graphId) =>
      prisma.edge.create({ data: { graphId: onGraph, fromName: from, toName: to } });

    beforeEach(async () => {
      await addNode('a');
      await addNode('b', { position: 1 });
    });

    it('accepts an edge between existing nodes', async () => {
      await expect(addEdge('a', 'b')).resolves.toBeDefined();
    });

    it('accepts a self-loop', async () => {
      await expect(addEdge('a', 'a')).resolves.toBeDefined();
    });

    it('rejects an edge to a missing node', async () => {
      await expectConstraintViolation(addEdge('a', 'missing'), 'edges_graph_id_to_name_fkey');
    });

    it('rejects an edge from a missing node', async () => {
      await expectConstraintViolation(addEdge('missing', 'b'), 'edges_graph_id_from_name_fkey');
    });

    it('rejects an edge that points to a node of another graph', async () => {
      const other = await prisma.graph.create({ data: { name: 'other' } });
      await prisma.node.create({ data: { graphId: other.id, name: 'foreign', position: 0, kind: 'service' } });

      await expectConstraintViolation(addEdge('a', 'foreign'), 'edges_graph_id_to_name_fkey');
    });

    it('rejects an edge of an unknown graph', async () => {
      await expectConstraintViolation(
        addEdge('a', 'b', '00000000-0000-0000-0000-000000000000'),
        'edges_graph_id_fkey',
      );
    });

    it('rejects a duplicate edge', async () => {
      await addEdge('a', 'b');

      await expectConstraintViolation(addEdge('a', 'b'), 'edges_pkey');
    });

    it('treats the reverse direction as a different edge', async () => {
      await addEdge('a', 'b');

      await expect(addEdge('b', 'a')).resolves.toBeDefined();
    });

    it('removes the edges of a node when the node is deleted', async () => {
      await addEdge('a', 'b');
      await addEdge('b', 'a');
      await addEdge('a', 'a');

      await prisma.node.delete({ where: { graphId_name: { graphId, name: 'a' } } });

      expect(await prisma.edge.count({ where: { graphId } })).toBe(0);
    });
  });

  describe('extra (the unknown fields of an upload)', () => {
    const asEdge = async (extra: unknown) => {
      await addNode('a');
      return prisma.edge.create({ data: { graphId, fromName: 'a', toName: 'a', extra: extra as never } });
    };

    it.each([
      ['an array', []],
      ['a string', 'x'],
      ['a number', 1],
      ['a boolean', true],
    ])('rejects %s on a graph, a node and an edge', async (_label, extra) => {
      await expectConstraintViolation(prisma.graph.create({ data: { name: 'x', extra: extra as never } }), 'graphs_extra_object_check');
      await expectConstraintViolation(addNode('n', { extra }), 'nodes_extra_object_check');
      await expectConstraintViolation(asEdge(extra), 'edges_extra_object_check');
    });

    it('accepts an object, an empty object and SQL NULL on a graph, a node and an edge', async () => {
      await expect(prisma.graph.create({ data: { name: 'obj', extra: { a: 1 } } })).resolves.toBeDefined();
      await expect(prisma.graph.create({ data: { name: 'empty', extra: {} } })).resolves.toBeDefined();
      await expect(prisma.graph.create({ data: { name: 'null' } })).resolves.toMatchObject({ extra: null });
      await expect(addNode('n', { extra: { a: [1] } })).resolves.toBeDefined();
      await expect(asEdge({ weight: 3 })).resolves.toMatchObject({ extra: { weight: 3 } });
    });
  });

  describe('graph_filters', () => {
    const addFilter = (key: string, data: Record<string, unknown> = {}) =>
      prisma.graphFilter.create({ data: { graphId, key, definition: {}, ...data } });

    it.each(['a', 'public', 'high-severity', 'sink2', 'a-b-c', `a${'b'.repeat(61)}c`])('accepts key %p', async (key) => {
      await expect(addFilter(key)).resolves.toBeDefined();
    });

    it.each(['', 'Upper', '1starts-with-digit', 'has space', 'under_score', '-leading', 'trailing-', 'a'.repeat(64), 'ünï'])(
      'rejects key %p',
      async (key) => {
        await expectConstraintViolation(addFilter(key), 'graph_filters_key_format_check');
      },
    );

    it('rejects a duplicate key within a graph', async () => {
      await addFilter('dup');

      await expectConstraintViolation(addFilter('dup'), 'graph_filters_graph_id_key_key');
    });

    it('allows the same key in different graphs', async () => {
      const other = await prisma.graph.create({ data: { name: 'other' } });
      await addFilter('shared');

      await expect(
        prisma.graphFilter.create({ data: { graphId: other.id, key: 'shared', definition: {} } }),
      ).resolves.toBeDefined();
    });

    it('rejects a filter of an unknown graph', async () => {
      await expectConstraintViolation(
        prisma.graphFilter.create({
          data: { graphId: '00000000-0000-0000-0000-000000000000', key: 'k', definition: {} },
        }),
        'graph_filters_graph_id_fkey',
      );
    });

    it.each([
      ['an array', []],
      ['a string', 'x'],
      ['a number', 1],
    ])('rejects a definition that is %s', async (_label, definition) => {
      await expectConstraintViolation(addFilter('k', { definition }), 'graph_filters_definition_object_check');
    });

    it('rejects a definition version below 1', async () => {
      await expectConstraintViolation(addFilter('k', { definitionVersion: 0 }), 'graph_filters_definition_version_check');
    });
  });
});
