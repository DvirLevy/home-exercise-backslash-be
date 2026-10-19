import type { RouteRoles } from '../../../../src/modules/queries/query.parser';
import { QueryService } from '../../../../src/modules/queries/query.service';
import { builtinRecords, GRAPH_ID, smallGraph, storeFor } from '../../../helpers/loaded';
import { filterRecord } from '../../../helpers/fakes';

const none: RouteRoles = { start: [], end: [], through: [] };
const roles = (r: Partial<RouteRoles>): RouteRoles => ({ ...none, ...r });

describe('QueryService', () => {
  const service = () => new QueryService(storeFor(smallGraph()).store);

  it('answers with the graph id, the version of the snapshot and the roles that were applied', async () => {
    const answer = await service().routes(GRAPH_ID, roles({ start: ['public'], end: ['sink'] }));

    expect(answer).toMatchObject({ graphId: GRAPH_ID, version: 3, applied: { start: ['public'], end: ['sink'], through: [] } });
  });

  it('finds the routes of the loaded graph', async () => {
    const { result } = await service().routes(GRAPH_ID, roles({ start: ['public'], end: ['sink'] }));

    expect(result.nodes.map((n) => n.node.name)).toEqual(['web', 'api', 'db']);
    expect(result.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['web>api', 'api>db']);
  });

  it('combines the filters of a role with OR', async () => {
    const { result } = await service().routes(GRAPH_ID, roles({ start: ['public', 'vulnerable'], end: ['sink'] }));

    expect(result.nodes.map((n) => n.node.name)).toEqual(['web', 'api', 'db']);
  });

  it('returns the whole graph when no role is given', async () => {
    const { result } = await service().routes(GRAPH_ID, none);

    expect(result.nodes).toHaveLength(5);
    expect(result.edges).toHaveLength(3);
  });

  it('throws NotFoundError for an unknown graph', async () => {
    const { store } = storeFor(null);

    await expect(new QueryService(store).routes(GRAPH_ID, none)).rejects.toMatchObject({ status: 404, code: 'GRAPH_NOT_FOUND' });
  });

  it('serves repeated queries from memory: the graph is loaded once', async () => {
    const { store, loader } = storeFor(smallGraph());
    const queries = new QueryService(store);

    await queries.routes(GRAPH_ID, roles({ start: ['public'] }));
    await queries.routes(GRAPH_ID, roles({ end: ['sink'] }));
    await queries.routes(GRAPH_ID, none);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  describe('unknown filters', () => {
    it('lists every unknown filter with the role it was used in, in one error', async () => {
      expect.assertions(4);
      try {
        await service().routes(GRAPH_ID, roles({ start: ['public', 'nope'], end: ['sink', 'gone'], through: ['also-missing'] }));
      } catch (err) {
        expect(err).toMatchObject({ status: 400, code: 'UNKNOWN_FILTER' });
        expect((err as { details: unknown[] }).details).toEqual([
          { path: 'start', message: 'Unknown filter "nope"' },
          { path: 'end', message: 'Unknown filter "gone"' },
          { path: 'through', message: 'Unknown filter "also-missing"' },
        ]);
        expect((err as Error).message).toContain('does not have');
        expect(true).toBe(true);
      }
    });

    it('is checked before any search runs', async () => {
      await expect(service().routes(GRAPH_ID, roles({ start: ['nope'] }))).rejects.toMatchObject({ code: 'UNKNOWN_FILTER' });
    });
  });

  describe('a stored filter whose rule does not compile', () => {
    const withBroken = () =>
      new QueryService(storeFor(smallGraph(), [...builtinRecords(), filterRecord('broken', { field: 'color', op: 'eq', value: 'x' })]).store);

    it('is reported as FILTER_UNAVAILABLE, not as unknown', async () => {
      await expect(withBroken().routes(GRAPH_ID, roles({ start: ['broken'] }))).rejects.toMatchObject({
        status: 409,
        code: 'FILTER_UNAVAILABLE',
        message: expect.stringContaining('"broken"'),
      });
    });

    it('does not affect queries that do not use it', async () => {
      const { result } = await withBroken().routes(GRAPH_ID, roles({ start: ['public'], end: ['sink'] }));

      expect(result.nodes).toHaveLength(3);
    });
  });
});
