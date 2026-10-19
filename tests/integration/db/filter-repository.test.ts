import type { PrismaClient } from '../../../src/infrastructure/prisma';
import type { JsonValue } from '../../../src/shared/json';
import { PrismaFilterRepository } from '../../../src/modules/filters/prisma-filter.repository';
import { PrismaGraphRepository } from '../../../src/modules/graphs/prisma-graph.repository';
import { builtinFilters, customFilter, sampleGraph } from '../../helpers/builders';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('PrismaFilterRepository', () => {
  let prisma: PrismaClient;
  let filters: PrismaFilterRepository;
  let graphId: string;

  beforeAll(() => {
    prisma = createTestPrisma();
    filters = new PrismaFilterRepository(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    graphId = (await new PrismaGraphRepository(prisma).create(sampleGraph())).id;
  });

  describe('create and read', () => {
    it('stores a filter and returns it with defaults applied', async () => {
      const created = await filters.create(graphId, customFilter('high-only', { description: 'High severity' }));

      expect(created).toMatchObject({
        graphId,
        key: 'high-only',
        description: 'High severity',
        definition: { field: 'kind', op: 'eq', value: 'service' },
        definitionVersion: 1,
        isBuiltin: false,
      });
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('finds a filter by key, or null', async () => {
      await filters.create(graphId, customFilter('known'));

      expect(await filters.findByKey(graphId, 'known')).toMatchObject({ key: 'known' });
      expect(await filters.findByKey(graphId, 'unknown')).toBeNull();
      expect(await filters.findByKey(UNKNOWN_ID, 'known')).toBeNull();
    });

    it('lists built-in filters first, then custom ones, each ordered by key', async () => {
      await filters.create(graphId, customFilter('zz-custom'));
      await filters.createMany(graphId, builtinFilters());
      await filters.create(graphId, customFilter('aa-custom'));

      const keys = (await filters.list(graphId)).map((f) => f.key);

      expect(keys).toEqual(['public', 'sink', 'vulnerable', 'aa-custom', 'zz-custom']);
    });

    it('lists only the filters of the requested graph', async () => {
      const other = (await new PrismaGraphRepository(prisma).create(sampleGraph('other'))).id;
      await filters.create(graphId, customFilter('mine'));
      await filters.create(other, customFilter('theirs'));

      expect((await filters.list(graphId)).map((f) => f.key)).toEqual(['mine']);
    });

    it('stores nested rule definitions unchanged', async () => {
      const definition: JsonValue = {
        all: [
          { field: 'kind', op: 'in', value: ['rds', 'sql'] },
          { not: { field: 'metadata.engine', op: 'eq', value: 'mysql' } },
          { field: 'vulnerabilities', op: 'some', where: { field: 'severity', op: 'eq', value: 'high' } },
        ],
      };

      await filters.create(graphId, customFilter('nested', { definition }));

      expect((await filters.findByKey(graphId, 'nested'))?.definition).toEqual(definition);
    });
  });

  describe('errors', () => {
    it('throws FILTER_KEY_EXISTS for a duplicate key', async () => {
      await filters.create(graphId, customFilter('dup'));

      await expect(filters.create(graphId, customFilter('dup'))).rejects.toMatchObject({
        status: 409,
        code: 'FILTER_KEY_EXISTS',
      });
    });

    it('allows the same key in another graph', async () => {
      const other = (await new PrismaGraphRepository(prisma).create(sampleGraph('other'))).id;
      await filters.create(graphId, customFilter('shared'));

      await expect(filters.create(other, customFilter('shared'))).resolves.toBeDefined();
    });

    it('throws GRAPH_NOT_FOUND for an unknown graph', async () => {
      await expect(filters.create(UNKNOWN_ID, customFilter('x'))).rejects.toMatchObject({
        status: 404,
        code: 'GRAPH_NOT_FOUND',
      });
      await expect(filters.createMany(UNKNOWN_ID, builtinFilters())).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });
    });

    it('createMany stores nothing when one filter is a duplicate', async () => {
      await expect(
        filters.createMany(graphId, [customFilter('first'), customFilter('second'), customFilter('first')]),
      ).rejects.toMatchObject({ code: 'FILTER_KEY_EXISTS' });

      expect(await filters.list(graphId)).toEqual([]);
    });

    it('lets the database refuse a malformed key', async () => {
      await expect(filters.create(graphId, customFilter('Bad Key'))).rejects.toThrow(/graph_filters_key_format_check/);
    });
  });

  describe('update', () => {
    it('changes description and definition but not the key or built-in flag', async () => {
      const created = await filters.create(graphId, customFilter('editable', { description: 'old' }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await filters.update(graphId, 'editable', {
        description: 'new',
        definition: { field: 'kind', op: 'eq', value: 'rds' },
      });

      expect(updated).toMatchObject({
        id: created.id,
        key: 'editable',
        description: 'new',
        definition: { field: 'kind', op: 'eq', value: 'rds' },
        isBuiltin: false,
      });
      expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    });

    it('can clear the description', async () => {
      await filters.create(graphId, customFilter('described', { description: 'text' }));

      const updated = await filters.update(graphId, 'described', { description: null, definition: {} });

      expect(updated.description).toBeNull();
    });

    it('throws FILTER_NOT_FOUND for an unknown key', async () => {
      await expect(filters.update(graphId, 'nope', { description: null, definition: {} })).rejects.toMatchObject({
        status: 404,
        code: 'FILTER_NOT_FOUND',
      });
    });
  });

  describe('delete', () => {
    it('removes only the named filter', async () => {
      await filters.createMany(graphId, [customFilter('keep'), customFilter('drop')]);

      await filters.delete(graphId, 'drop');

      expect((await filters.list(graphId)).map((f) => f.key)).toEqual(['keep']);
    });

    it('throws FILTER_NOT_FOUND for an unknown key', async () => {
      await expect(filters.delete(graphId, 'nope')).rejects.toMatchObject({ status: 404, code: 'FILTER_NOT_FOUND' });
    });
  });

  describe('cascade', () => {
    it('deleting a graph removes its filters and no one else\'s', async () => {
      const graphs = new PrismaGraphRepository(prisma);
      const other = (await graphs.create(sampleGraph('other'))).id;
      await filters.createMany(graphId, builtinFilters());
      await filters.createMany(other, builtinFilters());

      await graphs.delete(graphId);

      expect(await filters.list(graphId)).toEqual([]);
      expect(await filters.list(other)).toHaveLength(3);
    });
  });
});
