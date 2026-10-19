import { ConflictError, NotFoundError } from '../../../../src/http/errors';
import { FilterService } from '../../../../src/modules/filters/filter.service';
import { MAX_FILTERS_PER_GRAPH, type FilterRecord } from '../../../../src/modules/filters/filter.types';
import { fakeFilterRepository, fakeGraphRepository, fakeUnitOfWork, filterRecord, recordingCache } from '../../../helpers/fakes';
import { builtinRecords, GRAPH_ID, smallGraph, storeFor } from '../../../helpers/loaded';
import { serviceNode } from '../../../helpers/builders';

const nameIsWeb = { field: 'name', op: 'eq', value: 'web' };

/**
 * A service over an in-memory "database" of filter records: the transactional repositories change
 * `records`, and the store's loader reads them back, like the real thing.
 */
function setup(initial: FilterRecord[] = builtinRecords()) {
  const records = [...initial];
  const { store, loader } = storeFor(smallGraph(), records);

  const filters = fakeFilterRepository({
    list: jest.fn(async (_graphId: string) => [...records]),
    findByKey: jest.fn(async (_graphId: string, key: string) => records.find((r) => r.key === key) ?? null),
    create: jest.fn(async (_graphId, input) => {
      const record = filterRecord(input.key, input.definition, { description: input.description, isBuiltin: input.isBuiltin });
      records.push(record);
      return record;
    }),
    update: jest.fn(async (_graphId, key, changes) => {
      const index = records.findIndex((r) => r.key === key);
      records[index] = { ...records[index]!, description: changes.description, definition: changes.definition };
      return records[index]!;
    }),
    delete: jest.fn(async (_graphId, key) => {
      records.splice(records.findIndex((r) => r.key === key), 1);
    }),
  });
  const graphs = fakeGraphRepository();
  const unitOfWork = fakeUnitOfWork({ graphs, filters });
  const cache = recordingCache(unitOfWork);
  // Writes drop the store entry like the real wiring does.
  const dropping = { invalidate: (id: string) => { store.invalidate(id); cache.invalidate(id); } };
  return { service: new FilterService(unitOfWork, store, dropping), tx: unitOfWork.tx, unitOfWork, cache, store, loader, records };
}

describe('FilterService', () => {
  describe('list and get', () => {
    it('lists every filter with how many nodes it matches', async () => {
      const { service } = setup();

      const views = await service.list(GRAPH_ID);

      expect(views.map((v) => [v.record.key, v.matchCount])).toEqual([['public', 1], ['sink', 1], ['vulnerable', 1]]);
    });

    it('gets one filter by key', async () => {
      const { service } = setup();

      const view = await service.get(GRAPH_ID, 'sink');

      expect(view.record.isBuiltin).toBe(true);
      expect(view.matchCount).toBe(1);
    });

    it('throws FILTER_NOT_FOUND for an unknown key and GRAPH_NOT_FOUND for an unknown graph', async () => {
      const { service } = setup();
      const missingGraph = new FilterService(fakeUnitOfWork(), storeFor(null).store, { invalidate: () => undefined });

      await expect(service.get(GRAPH_ID, 'nope')).rejects.toMatchObject({ status: 404, code: 'FILTER_NOT_FOUND' });
      await expect(missingGraph.list(GRAPH_ID)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
      await expect(missingGraph.get(GRAPH_ID, 'public')).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });
    });

    it('reports a null count for a filter whose stored rule does not compile', async () => {
      const { service } = setup([...builtinRecords(), filterRecord('broken', { field: 'color', op: 'eq', value: 'x' })]);

      const view = await service.get(GRAPH_ID, 'broken');

      expect(view.matchCount).toBeNull();
    });

    it('reads from memory: one load for any number of reads', async () => {
      const { service, loader } = setup();

      await service.list(GRAPH_ID);
      await service.get(GRAPH_ID, 'public');
      await service.get(GRAPH_ID, 'sink');

      expect(loader).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('validates the rule before opening a transaction, so a bad rule takes no lock and changes nothing', async () => {
      const { service, unitOfWork, cache } = setup();

      await expect(service.create(GRAPH_ID, 'bad', { definition: { field: 'color', op: 'eq', value: 1 } })).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_FILTER_RULE',
      });
      await expect(service.create(GRAPH_ID, 'missing', { definition: undefined })).rejects.toMatchObject({ code: 'INVALID_FILTER_RULE' });

      expect(unitOfWork.run).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('bumps the graph version first, then stores the filter as a custom one, in one transaction', async () => {
      const { service, tx, unitOfWork } = setup();

      await service.create(GRAPH_ID, 'web-only', { description: 'Just web', definition: nameIsWeb });

      expect(unitOfWork.run).toHaveBeenCalledTimes(1);
      expect(tx.graphs.bumpVersion).toHaveBeenCalledWith(GRAPH_ID); // no expected version
      expect(tx.filters.create).toHaveBeenCalledWith(GRAPH_ID, { key: 'web-only', description: 'Just web', definition: nameIsWeb, isBuiltin: false });
      expect(tx.graphs.bumpVersion.mock.invocationCallOrder[0]!).toBeLessThan(tx.filters.create.mock.invocationCallOrder[0]!);
    });

    it.each([undefined, null, ''])('stores the description %p as "no description"', async (description) => {
      const { service, tx } = setup();

      await service.create(GRAPH_ID, 'f', { description, definition: nameIsWeb });

      expect(tx.filters.create.mock.calls[0]![1].description).toBeNull();
    });

    it('drops the cache only after the commit and returns the fresh filter with its match count', async () => {
      const { service, cache } = setup();

      const view = await service.create(GRAPH_ID, 'web-only', { definition: nameIsWeb });

      expect(cache.calls).toEqual([{ id: GRAPH_ID, afterCommit: true }]);
      expect(view.record).toMatchObject({ key: 'web-only', isBuiltin: false });
      expect(view.matchCount).toBe(1);
    });

    it('makes the new filter visible to the very next read', async () => {
      const { service } = setup();
      await service.list(GRAPH_ID); // warms the cache

      await service.create(GRAPH_ID, 'web-only', { definition: nameIsWeb });

      expect((await service.list(GRAPH_ID)).map((v) => v.record.key)).toEqual(['public', 'sink', 'vulnerable', 'web-only']);
    });

    it('refuses to go over the limit of filters per graph', async () => {
      const full = Array.from({ length: MAX_FILTERS_PER_GRAPH }, (_, i) => filterRecord(`f${i}`, nameIsWeb));
      const { service, tx, cache } = setup(full);

      await expect(service.create(GRAPH_ID, 'one-more', { definition: nameIsWeb })).rejects.toMatchObject({
        status: 409,
        code: 'FILTER_LIMIT_REACHED',
      });
      expect(tx.filters.create).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('accepts the filter that exactly reaches the limit', async () => {
      const almost = Array.from({ length: MAX_FILTERS_PER_GRAPH - 1 }, (_, i) => filterRecord(`f${i}`, nameIsWeb));
      const { service } = setup(almost);

      await expect(service.create(GRAPH_ID, 'last', { definition: nameIsWeb })).resolves.toBeDefined();
    });

    it('leaves the cache alone when the key is taken or the graph is gone', async () => {
      const taken = setup();
      taken.tx.filters.create.mockRejectedValue(new ConflictError('exists', 'FILTER_KEY_EXISTS'));
      const gone = setup();
      gone.tx.graphs.bumpVersion.mockRejectedValue(new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND'));

      await expect(taken.service.create(GRAPH_ID, 'public', { definition: nameIsWeb })).rejects.toMatchObject({ code: 'FILTER_KEY_EXISTS' });
      await expect(gone.service.create(GRAPH_ID, 'x', { definition: nameIsWeb })).rejects.toMatchObject({ code: 'GRAPH_NOT_FOUND' });

      expect(taken.cache.calls).toEqual([]);
      expect(gone.cache.calls).toEqual([]);
      expect(gone.tx.filters.create).not.toHaveBeenCalled();
    });
  });

  describe('replace', () => {
    const custom = () => setup([...builtinRecords(), filterRecord('mine', { field: 'name', op: 'eq', value: 'api' }, { description: 'old' })]);

    it('changes the description and the rule, keeping the key', async () => {
      const { service, tx } = custom();

      const view = await service.replace(GRAPH_ID, 'mine', { description: 'new', definition: nameIsWeb });

      expect(tx.filters.update).toHaveBeenCalledWith(GRAPH_ID, 'mine', { description: 'new', definition: nameIsWeb });
      expect(view.record).toMatchObject({ key: 'mine', description: 'new', definition: nameIsWeb });
      expect(view.matchCount).toBe(1);
    });

    it('clears the description when none is sent (PUT replaces the whole filter)', async () => {
      const { service, tx } = custom();

      await service.replace(GRAPH_ID, 'mine', { definition: nameIsWeb });

      expect(tx.filters.update.mock.calls[0]![2].description).toBeNull();
    });

    it('bumps the version first and drops the cache only after the commit', async () => {
      const { service, tx, cache } = custom();

      await service.replace(GRAPH_ID, 'mine', { definition: nameIsWeb });

      expect(tx.graphs.bumpVersion.mock.invocationCallOrder[0]!).toBeLessThan(tx.filters.update.mock.invocationCallOrder[0]!);
      expect(cache.calls).toEqual([{ id: GRAPH_ID, afterCommit: true }]);
    });

    it('refuses to change a built-in filter', async () => {
      const { service, tx, cache } = custom();

      await expect(service.replace(GRAPH_ID, 'public', { definition: nameIsWeb })).rejects.toMatchObject({
        status: 409,
        code: 'BUILTIN_FILTER_READ_ONLY',
      });
      expect(tx.filters.update).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('throws FILTER_NOT_FOUND for an unknown key', async () => {
      const { service, cache } = custom();

      await expect(service.replace(GRAPH_ID, 'nope', { definition: nameIsWeb })).rejects.toMatchObject({ status: 404, code: 'FILTER_NOT_FOUND' });
      expect(cache.calls).toEqual([]);
    });

    it('rejects an invalid rule before any transaction', async () => {
      const { service, unitOfWork } = custom();

      await expect(service.replace(GRAPH_ID, 'mine', { definition: { all: [] } })).rejects.toMatchObject({ code: 'INVALID_FILTER_RULE' });
      expect(unitOfWork.run).not.toHaveBeenCalled();
    });

    it('repairs a filter whose stored rule no longer compiles', async () => {
      const { service } = setup([...builtinRecords(), filterRecord('broken', { field: 'color', op: 'eq', value: 'x' })]);
      expect((await service.get(GRAPH_ID, 'broken')).matchCount).toBeNull();

      const fixed = await service.replace(GRAPH_ID, 'broken', { definition: nameIsWeb });

      expect(fixed.matchCount).toBe(1);
    });
  });

  describe('delete', () => {
    it('removes a custom filter, bumping the version and dropping the cache after the commit', async () => {
      const { service, tx, cache } = setup([...builtinRecords(), filterRecord('mine', nameIsWeb)]);

      await service.delete(GRAPH_ID, 'mine');

      expect(tx.graphs.bumpVersion).toHaveBeenCalledWith(GRAPH_ID);
      expect(tx.filters.delete).toHaveBeenCalledWith(GRAPH_ID, 'mine');
      expect(cache.calls).toEqual([{ id: GRAPH_ID, afterCommit: true }]);
      await expect(service.get(GRAPH_ID, 'mine')).rejects.toMatchObject({ code: 'FILTER_NOT_FOUND' });
    });

    it.each(['public', 'sink', 'vulnerable'])('refuses to delete the built-in filter %s', async (key) => {
      const { service, tx, cache } = setup();

      await expect(service.delete(GRAPH_ID, key)).rejects.toMatchObject({ status: 409, code: 'BUILTIN_FILTER_READ_ONLY' });
      expect(tx.filters.delete).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('throws FILTER_NOT_FOUND for an unknown key', async () => {
      const { service } = setup();

      await expect(service.delete(GRAPH_ID, 'nope')).rejects.toMatchObject({ status: 404, code: 'FILTER_NOT_FOUND' });
    });
  });

  describe('preview', () => {
    it('returns the names of the matching nodes without touching the database', async () => {
      const { service, unitOfWork, tx } = setup();

      const preview = await service.preview(GRAPH_ID, { field: 'name', op: 'in', value: ['web', 'db', 'nobody'] });

      expect(preview).toEqual({ matchCount: 2, matches: ['web', 'db'] });
      expect(unitOfWork.run).not.toHaveBeenCalled();
      expect(tx.graphs.bumpVersion).not.toHaveBeenCalled();
      expect(tx.filters.create).not.toHaveBeenCalled();
    });

    it('never lists a placeholder, even for a rule that matches everything', async () => {
      const withPlaceholder = smallGraph({
        nodes: [serviceNode('real'), { ...serviceNode('ghost'), kind: null, isPlaceholder: true }],
        edges: [{ from: 'real', to: 'ghost', extra: null }],
      });
      const service = new FilterService(fakeUnitOfWork(), storeFor(withPlaceholder).store, { invalidate: () => undefined });

      const preview = await service.preview(GRAPH_ID, { field: 'name', op: 'exists' });

      expect(preview.matches).toEqual(['real']);
    });

    it('matches nothing, without failing, for a rule nobody satisfies', async () => {
      const { service } = setup();

      expect(await service.preview(GRAPH_ID, { field: 'name', op: 'eq', value: 'zzz' })).toEqual({ matchCount: 0, matches: [] });
    });

    it('rejects an invalid rule without loading the graph', async () => {
      const { service, loader } = setup();

      await expect(service.preview(GRAPH_ID, { field: 'nope', op: 'eq', value: 1 })).rejects.toMatchObject({ code: 'INVALID_FILTER_RULE' });
      expect(loader).not.toHaveBeenCalled();
    });

    it('throws GRAPH_NOT_FOUND for an unknown graph', async () => {
      const service = new FilterService(fakeUnitOfWork(), storeFor(null).store, { invalidate: () => undefined });

      await expect(service.preview(GRAPH_ID, nameIsWeb)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
    });
  });
});
