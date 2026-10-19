import { createGraphLoader } from '../../../../src/modules/queries/graph-loader';
import { builtinRecords, GRAPH_ID, smallGraph } from '../../../helpers/loaded';
import { fakeFilterRepository, fakeGraphRepository, filterRecord, silentTestLogger } from '../../../helpers/fakes';
import { sorted } from '../../../helpers/engine';

function loaderFor(filters = builtinRecords(), graph: ReturnType<typeof smallGraph> | null = smallGraph()) {
  const graphs = fakeGraphRepository({ findWithData: jest.fn(async (_id: string) => graph) });
  const filterRepo = fakeFilterRepository({ list: jest.fn(async (_graphId: string) => filters) });
  return { load: createGraphLoader({ graphs, filters: filterRepo, logger: silentTestLogger }), graphs, filterRepo };
}

beforeEach(() => silentTestLogger.warn.mockClear());

describe('createGraphLoader', () => {
  it('returns null for a graph that does not exist, without reading filters', async () => {
    const { load, filterRepo } = loaderFor([], null);

    expect(await load(GRAPH_ID)).toBeNull();
    expect(filterRepo.list).not.toHaveBeenCalled();
  });

  it('builds a snapshot of the stored graph at its version', async () => {
    const { load } = loaderFor();

    const loaded = (await load(GRAPH_ID))!;

    expect(loaded.snapshot.graphId).toBe(GRAPH_ID);
    expect(loaded.snapshot.version).toBe(3);
    expect(loaded.snapshot.nodes.size).toBe(5);
    expect(loaded.snapshot.edgeCount).toBe(3);
  });

  it('compiles each stored rule and fills the filter index', async () => {
    const { load } = loaderFor();

    const { snapshot, unusable } = (await load(GRAPH_ID))!;

    expect(sorted(snapshot.filterIndex.get('public')!)).toEqual(['web']);
    expect(sorted(snapshot.filterIndex.get('sink')!)).toEqual(['db']);
    expect(sorted(snapshot.filterIndex.get('vulnerable')!)).toEqual(['api']);
    expect(unusable.size).toBe(0);
  });

  it('keeps the filter records it was built from', async () => {
    const records = [...builtinRecords(), filterRecord('mine', { field: 'name', op: 'eq', value: 'web' }, { description: 'x' })];
    const { load } = loaderFor(records);

    const loaded = (await load(GRAPH_ID))!;

    expect(loaded.filters.map((f) => f.key)).toEqual(['public', 'sink', 'vulnerable', 'mine']);
    expect(sorted(loaded.snapshot.filterIndex.get('mine')!)).toEqual(['web']);
  });

  it('works for a graph with no filters at all', async () => {
    const { load } = loaderFor([]);

    const loaded = (await load(GRAPH_ID))!;

    expect(loaded.snapshot.filterIndex.size).toBe(0);
    expect(loaded.filters).toEqual([]);
  });

  describe('a stored rule that does not compile', () => {
    const records = () => [
      ...builtinRecords(),
      filterRecord('broken', { field: 'color', op: 'eq', value: 'red' }), // unknown field
      filterRecord('not-a-rule', {}), // an object, but not a rule
      filterRecord('newer', { field: 'name', op: 'eq', value: 'web' }, { definitionVersion: 2 }), // a rule format this code does not know
      filterRecord('fine', { field: 'name', op: 'eq', value: 'web' }),
    ];

    it('is skipped and reported, and does not stop the graph or the other filters from loading', async () => {
      const { load } = loaderFor(records());

      const loaded = (await load(GRAPH_ID))!;

      expect(sorted(loaded.unusable)).toEqual(['broken', 'newer', 'not-a-rule']);
      expect(sorted(loaded.snapshot.filterIndex.keys())).toEqual(['fine', 'public', 'sink', 'vulnerable']);
      expect(sorted(loaded.snapshot.filterIndex.get('fine')!)).toEqual(['web']);
    });

    it('is logged as a warning that names the graph and the filter', async () => {
      const { load } = loaderFor(records());

      await load(GRAPH_ID);

      expect(silentTestLogger.warn).toHaveBeenCalledTimes(3);
      expect(silentTestLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ graphId: GRAPH_ID, filter: 'broken' }),
        expect.stringContaining('does not compile'),
      );
    });

    it('is still listed among the filter records, so it can be fixed', async () => {
      const { load } = loaderFor(records());

      const loaded = (await load(GRAPH_ID))!;

      expect(loaded.filters.map((f) => f.key)).toContain('broken');
    });
  });
});
