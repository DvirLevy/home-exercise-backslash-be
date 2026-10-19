import { ZodError } from 'zod';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from '../../../../src/http/errors';
import { BUILTIN_FILTERS } from '../../../../src/modules/filters/builtin-filters';
import { GraphService } from '../../../../src/modules/graphs/graph.service';
import type { StoredGraph } from '../../../../src/modules/graphs/graph.types';
import { fakeGraphRepository, fakeUnitOfWork, recordingCache, summaryOf } from '../../../helpers/fakes';
import { sampleGraphJson } from '../../../helpers/sample-graph-file';

const ID = '11111111-1111-1111-1111-111111111111';
const LIMITS = { maxNodes: 100, maxEdges: 100 };

const validFile = () => ({
  nodes: [
    { name: 'a', kind: 'service', publicExposed: true },
    { name: 'b', kind: 'rds' },
  ],
  edges: [{ from: 'a', to: ['b', 'ghost'] }],
});

function setup() {
  const graphs = fakeGraphRepository(); // what the service reads with outside any transaction
  const unitOfWork = fakeUnitOfWork();
  const cache = recordingCache(unitOfWork);
  const service = new GraphService(graphs, unitOfWork, cache, LIMITS);
  return { service, graphs, unitOfWork, tx: unitOfWork.tx, cache };
}

describe('GraphService', () => {
  describe('create', () => {
    it('stores the graph and its built-in filters in one transaction', async () => {
      const { service, graphs, unitOfWork, tx } = setup();

      const result = await service.create('My graph', validFile());

      expect(unitOfWork.run).toHaveBeenCalledTimes(1);
      expect(tx.graphs.create).toHaveBeenCalledTimes(1);
      expect(tx.filters.createMany).toHaveBeenCalledWith(ID, [...BUILTIN_FILTERS]);
      expect(graphs.create).not.toHaveBeenCalled(); // never outside the transaction
      expect(result.summary).toMatchObject({ name: 'My graph', nodeCount: 3, edgeCount: 2 });
    });

    it('passes normalized data: split edges and a placeholder', async () => {
      const { service, tx } = setup();

      const result = await service.create('g', validFile());

      expect(result.placeholders).toEqual(['ghost']);
      const stored = tx.graphs.create.mock.calls[0]![0];
      expect(stored.nodes.map((n) => n.name)).toEqual(['a', 'b', 'ghost']);
      expect(stored.edges).toEqual([
        { from: 'a', to: 'b', extra: null },
        { from: 'a', to: 'ghost', extra: null },
      ]);
    });

    it('hands the unknown fields of every level to the repository', async () => {
      const { service, tx } = setup();

      await service.create('g', {
        title: 'top',
        nodes: [{ name: 'a', kind: 'service', owner: 'team' }],
        edges: [{ from: 'a', to: 'b', protocol: 'grpc' }],
      });

      const stored = tx.graphs.create.mock.calls[0]![0];
      expect(stored.extra).toEqual({ title: 'top' });
      expect(stored.nodes[0]?.extra).toEqual({ owner: 'team' });
      expect(stored.edges).toEqual([{ from: 'a', to: 'b', extra: { protocol: 'grpc' } }]);
    });

    it('stores the three built-in filters in the sample run', async () => {
      const { service, tx } = setup();

      await service.create('train', sampleGraphJson());

      const filters = tx.filters.createMany.mock.calls[0]![1];
      expect(filters.map((f) => f.key)).toEqual(['public', 'sink', 'vulnerable']);
      expect(filters.every((f) => f.isBuiltin)).toBe(true);
    });

    it.each([
      ['a schema error', { nodes: [{ name: 'a' }], edges: [] }, ZodError],
      ['a file that is not an object', [], ZodError],
      ['duplicate node names', { nodes: [{ name: 'a', kind: 's' }, { name: 'a', kind: 's' }], edges: [] }, ValidationError],
    ])('rejects %s before opening a transaction', async (_label, content, errorType) => {
      const { service, unitOfWork } = setup();

      await expect(service.create('g', content)).rejects.toBeInstanceOf(errorType);
      expect(unitOfWork.run).not.toHaveBeenCalled();
    });

    it('enforces the configured limits', async () => {
      const { graphs, unitOfWork, cache } = setup();
      const tight = new GraphService(graphs, unitOfWork, cache, { maxNodes: 1, maxEdges: 100 });

      await expect(tight.create('g', validFile())).rejects.toBeInstanceOf(PayloadTooLargeError);
    });

    it('does not report success when the transaction fails', async () => {
      const { service, tx } = setup();
      tx.filters.createMany.mockRejectedValue(new Error('db down'));

      await expect(service.create('g', validFile())).rejects.toThrow('db down');
    });
  });

  describe('list and get', () => {
    it('lists through the repository', async () => {
      const { service, graphs } = setup();
      graphs.list.mockResolvedValue([summaryOf({ name: 'x' })]);

      expect(await service.list()).toEqual([summaryOf({ name: 'x' })]);
    });

    it('returns a stored graph', async () => {
      const { service, graphs } = setup();
      const stored: StoredGraph = { id: ID, name: 'g', version: 4, extra: null, nodes: [], edges: [] };
      graphs.findWithData.mockResolvedValue(stored);

      expect(await service.get(ID)).toBe(stored);
    });

    it('throws NotFoundError for an unknown graph', async () => {
      const { service } = setup();

      await expect(service.get(ID)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
    });
  });

  describe('replace', () => {
    it('bumps the version first, then replaces the data, all inside the transaction', async () => {
      const { service, tx, graphs } = setup();

      const result = await service.replace(ID, { content: validFile(), expectedVersion: 3 });

      expect(tx.graphs.bumpVersion).toHaveBeenCalledWith(ID, 3);
      expect(tx.graphs.replaceData).toHaveBeenCalledTimes(1);
      expect(tx.graphs.bumpVersion.mock.invocationCallOrder[0]!).toBeLessThan(
        tx.graphs.replaceData.mock.invocationCallOrder[0]!,
      );
      expect(graphs.replaceData).not.toHaveBeenCalled();
      expect(result.placeholders).toEqual(['ghost']);
    });

    it('replaces the unknown fields of every level along with the data', async () => {
      const { service, tx } = setup();

      await service.replace(ID, {
        content: { note: 'new', nodes: [{ name: 'a', kind: 'service', owner: 'team' }], edges: [{ from: 'a', to: 'a', w: 1 }] },
      });

      const [, data] = tx.graphs.replaceData.mock.calls[0]!;
      expect(data.extra).toEqual({ note: 'new' });
      expect(data.nodes[0]?.extra).toEqual({ owner: 'team' });
      expect(data.edges).toEqual([{ from: 'a', to: 'a', extra: { w: 1 } }]);
    });

    it('does not require an expected version', async () => {
      const { service, tx } = setup();

      await service.replace(ID, { content: validFile() });

      expect(tx.graphs.bumpVersion).toHaveBeenCalledWith(ID, undefined);
    });

    it('keeps the name when none is given, and renames inside the transaction when it is', async () => {
      const { service, tx } = setup();

      await service.replace(ID, { content: validFile() });
      expect(tx.graphs.rename).not.toHaveBeenCalled();
      expect(tx.graphs.findSummary).toHaveBeenCalledWith(ID);

      const renamed = await service.replace(ID, { content: validFile(), name: 'new name' });
      expect(tx.graphs.rename).toHaveBeenCalledWith(ID, 'new name');
      expect(renamed.summary.name).toBe('new name');
    });

    it('drops the cache entry only after the transaction committed', async () => {
      const { service, cache } = setup();

      await service.replace(ID, { content: validFile() });

      expect(cache.calls).toEqual([{ id: ID, afterCommit: true }]);
    });

    it('validates the file before opening a transaction, so a bad upload takes no lock', async () => {
      const { service, unitOfWork, cache } = setup();

      await expect(service.replace(ID, { content: { nodes: 'x', edges: [] } })).rejects.toBeInstanceOf(ZodError);

      expect(unitOfWork.run).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('leaves the cache alone when the version check fails', async () => {
      const { service, tx, cache } = setup();
      tx.graphs.bumpVersion.mockRejectedValue(new ConflictError('stale', 'VERSION_CONFLICT'));

      await expect(service.replace(ID, { content: validFile(), expectedVersion: 1 })).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
      });

      expect(tx.graphs.replaceData).not.toHaveBeenCalled();
      expect(cache.calls).toEqual([]);
    });

    it('leaves the cache alone when writing the data fails', async () => {
      const { service, tx, cache } = setup();
      tx.graphs.replaceData.mockRejectedValue(new Error('constraint violated'));

      await expect(service.replace(ID, { content: validFile() })).rejects.toThrow('constraint violated');

      expect(cache.calls).toEqual([]);
    });

    it('throws NotFoundError (and keeps the cache) when the graph vanished', async () => {
      const { service, tx, cache } = setup();
      tx.graphs.bumpVersion.mockRejectedValue(new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND'));

      await expect(service.replace(ID, { content: validFile() })).rejects.toMatchObject({ status: 404 });
      expect(cache.calls).toEqual([]);
    });

    it('fails with NotFoundError if the summary cannot be read back', async () => {
      const { service, tx } = setup();
      tx.graphs.findSummary.mockResolvedValue(null);

      await expect(service.replace(ID, { content: validFile() })).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('rename', () => {
    it('renames through the repository and leaves the cache alone (results do not change)', async () => {
      const { service, graphs, cache, unitOfWork } = setup();

      const summary = await service.rename(ID, 'new');

      expect(graphs.rename).toHaveBeenCalledWith(ID, 'new');
      expect(summary.name).toBe('new');
      expect(cache.calls).toEqual([]);
      expect(unitOfWork.run).not.toHaveBeenCalled();
    });

    it('propagates NotFoundError', async () => {
      const { service, graphs } = setup();
      graphs.rename.mockRejectedValue(new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND'));

      await expect(service.rename(ID, 'x')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('delete', () => {
    it('deletes and then drops the cache entry', async () => {
      const { service, graphs, cache } = setup();

      await service.delete(ID);

      expect(graphs.delete).toHaveBeenCalledWith(ID);
      expect(cache.calls).toHaveLength(1);
      expect(cache.calls[0]!.id).toBe(ID);
    });

    it('keeps the cache when the delete fails', async () => {
      const { service, graphs, cache } = setup();
      graphs.delete.mockRejectedValue(new NotFoundError('Graph not found', 'GRAPH_NOT_FOUND'));

      await expect(service.delete(ID)).rejects.toMatchObject({ status: 404 });
      expect(cache.calls).toEqual([]);
    });
  });
});
