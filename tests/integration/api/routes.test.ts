import type { Express } from 'express';
import request from 'supertest';
import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { filtersPath, GRAPHS, graphFile, replaceGraph, routesPath, smallGraphFile, uploadGraph } from '../../helpers/api';
import { SAMPLE_EXPECTED, sampleGraphBuffer } from '../../helpers/sample-graph-file';
import { createDatabaseTestApp } from '../../helpers/test-app';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

interface RouteNode {
  name: string;
  matched: { roles: string[]; filters: string[] };
  [key: string]: unknown;
}

describe('Routes API', () => {
  let prisma: PrismaClient;
  let app: Express;

  beforeAll(() => {
    prisma = createTestPrisma();
    app = createDatabaseTestApp(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  async function createGraph(file: Buffer = smallGraphFile()): Promise<string> {
    const res = await uploadGraph(app, file);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  const routes = (id: string, query = '') => request(app).get(`${routesPath(id)}${query ? `?${query}` : ''}`);
  const names = (res: request.Response): string[] => res.body.nodes.map((n: RouteNode) => n.name);
  const edges = (res: request.Response): string[] => res.body.edges.map((e: { from: string; to: string }) => `${e.from}>${e.to}`).sort();

  describe('on the sample file', () => {
    let id: string;
    beforeEach(async () => {
      id = await createGraph(sampleGraphBuffer());
    });

    it('finds no route from public services to a database sink', async () => {
      const res = await routes(id, 'start=public&end=sink');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        graphId: id,
        version: 1,
        applied: { start: ['public'], end: ['sink'], through: [] },
        nodes: [],
        edges: [],
      });
    });

    it('finds the routes that pass through a vulnerable node on their way to the database', async () => {
      const res = await routes(id, 'through=vulnerable&end=sink');
      const found = new Set(names(res));

      expect(res.status).toBe(200);
      for (const name of ['order-service', 'auth-service', 'prod-postgresdb', 'user-service', 'cancel-service']) expect(found).toContain(name);
      for (const name of ['prod-sqs', 'frontend', 'gateway-service', 'assurance-service', 'station-service']) expect(found).not.toContain(name);
      expect(edges(res)).toContain('auth-service>prod-postgresdb');
      expect(edges(res)).toContain('order-service>prod-postgresdb');
      expect(edges(res)).not.toContain('order-service>station-service');
    });

    it('describes every returned node like the graph does, plus what it matched', async () => {
      const res = await routes(id, 'through=vulnerable&end=sink');

      const db = res.body.nodes.find((n: RouteNode) => n.name === 'prod-postgresdb');
      const order = res.body.nodes.find((n: RouteNode) => n.name === 'order-service');
      expect(db).toMatchObject({ kind: 'rds', placeholder: false, metadata: { engine: 'postgres' }, matched: { roles: ['end'], filters: ['sink'] } });
      expect(order).toMatchObject({ kind: 'service', language: 'java', matched: { roles: ['through'], filters: ['vulnerable'] } });
      expect(order.vulnerabilities).toHaveLength(2);
      expect(Object.keys(order).sort()).toEqual(
        ['extra', 'kind', 'language', 'matched', 'metadata', 'name', 'path', 'placeholder', 'publicExposed', 'vulnerabilities'],
      );
    });

    it('returns only edges between the nodes it returns', async () => {
      const res = await routes(id, 'through=vulnerable&end=sink');
      const found = new Set(names(res));

      for (const edge of res.body.edges) {
        expect(found.has(edge.from) && found.has(edge.to)).toBe(true);
        expect(edge).not.toHaveProperty('extra'); // the sample has no unknown edge fields
      }
    });

    it('returns the whole graph, placeholder included, when no role is given', async () => {
      const res = await routes(id);

      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(SAMPLE_EXPECTED.nodes);
      expect(res.body.edges).toHaveLength(SAMPLE_EXPECTED.edges);
      expect(res.body.applied).toEqual({ start: [], end: [], through: [] });
      expect(res.body.nodes.every((n: RouteNode) => n.matched.roles.length === 0 && n.matched.filters.length === 0)).toBe(true);
    });

    it('lists everything reachable from the public services when only a start is given', async () => {
      const res = await routes(id, 'start=public');

      expect(names(res).sort()).toEqual(
        ['admin-basic-info-service', 'config-service', 'contacts-service', 'frontend', 'gateway-service', 'price-service', 'station-service', 'train-service'],
      );
    });

    it('returns less than the whole graph as soon as a role excludes something', async () => {
      const everything = await routes(id);
      const viaSink = await routes(id, 'end=sink');

      expect(names(viaSink).length).toBeLessThan(names(everything).length);
      expect(names(viaSink)).toContain('prod-postgresdb');
    });
  });

  describe('on a small graph', () => {
    let id: string;
    beforeEach(async () => {
      id = await createGraph();
    });

    it('returns the subgraph of every route from the start to the end, with the roles', async () => {
      const res = await routes(id, 'start=public&end=sink');

      expect(names(res)).toEqual(['web', 'api', 'db']);
      expect(edges(res)).toEqual(['api>db', 'web>api']);
      expect(res.body.nodes.map((n: RouteNode) => [n.name, n.matched])).toEqual([
        ['web', { roles: ['start'], filters: ['public'] }],
        ['api', { roles: [], filters: [] }],
        ['db', { roles: ['end'], filters: ['sink'] }],
      ]);
    });

    it('requires the route to pass through the through filter', async () => {
      expect(names(await routes(id, 'start=public&end=sink&through=vulnerable'))).toEqual(['web', 'api', 'db']);
      expect(names(await routes(id, 'start=public&end=sink&through=public'))).toEqual(['web', 'api', 'db']); // a start node counts
      expect(names(await routes(id, 'start=public&end=sink&through=sink'))).toEqual(['web', 'api', 'db']); // so does an end node
    });

    it('leaves out routes that miss the through node', async () => {
      await request(app).post(filtersPath(id)).send({ key: 'cachey', definition: { field: 'kind', op: 'eq', value: 'sqs' } });

      const res = await routes(id, 'start=public&end=sink&through=cachey');

      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([]); // cache is a dead end: no route through it reaches the database
    });

    it('treats a role left out as unconstrained', async () => {
      expect(names(await routes(id, 'start=public'))).toEqual(['web', 'api', 'db', 'cache', 'dead']);
      expect(names(await routes(id, 'end=sink'))).toEqual(['web', 'api', 'db']);
      expect(names(await routes(id, 'through=vulnerable'))).toEqual(['web', 'api', 'db', 'cache', 'dead']);
    });

    describe('several filters in one role (OR)', () => {
      it('accepts a route that starts at any of them', async () => {
        const res = await routes(id, 'start=public&start=vulnerable&end=sink');

        expect(names(res)).toEqual(['web', 'api', 'db']);
        expect(res.body.nodes.find((n: RouteNode) => n.name === 'api').matched).toEqual({ roles: ['start'], filters: ['vulnerable'] });
        expect(res.body.applied.start).toEqual(['public', 'vulnerable']);
      });

      it('gives the union: either filter on its own would find less', async () => {
        const either = await routes(id, 'end=sink&end=vulnerable');
        const sinkOnly = await routes(id, 'end=sink');
        const vulnerableOnly = await routes(id, 'end=vulnerable');

        expect(names(sinkOnly)).toEqual(['web', 'api', 'db']);
        expect(names(vulnerableOnly)).toEqual(['web', 'api']);
        expect(names(either)).toEqual(['web', 'api', 'db']);
        expect(edges(either)).toEqual(['api>db', 'web>api']);
      });

      it('removes repeats of the same filter', async () => {
        const res = await routes(id, 'start=public&start=public&end=sink');

        expect(res.body.applied.start).toEqual(['public']);
        expect(names(res)).toEqual(['web', 'api', 'db']);
      });
    });

    it('requires all roles at once (AND between roles)', async () => {
      const res = await routes(id, 'start=sink&end=public'); // starting at the database and ending at the web tier: no such route

      expect(res.body.nodes).toEqual([]);
    });

    it('answers 200 with empty lists when no route matches', async () => {
      const res = await routes(id, 'start=sink&end=vulnerable');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ nodes: [], edges: [], version: 1 });
    });

    it('uses custom filters like the built-in ones', async () => {
      await request(app).post(filtersPath(id)).send({ key: 'engine-pg', definition: { field: 'metadata.engine', op: 'eq', value: 'postgres' } });

      const res = await routes(id, 'start=public&end=engine-pg');

      expect(names(res)).toEqual(['web', 'api', 'db']);
      expect(res.body.nodes[2].matched).toEqual({ roles: ['end'], filters: ['engine-pg'] });
    });
  });

  describe('errors', () => {
    let id: string;
    beforeEach(async () => {
      id = await createGraph();
    });

    it('400 UNKNOWN_FILTER lists every unknown filter with its role', async () => {
      const res = await routes(id, 'start=public&start=nope&end=gone&through=vulnerable&through=also-missing');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_FILTER');
      expect(res.body.error.details).toEqual([
        { path: 'start', message: 'Unknown filter "nope"' },
        { path: 'end', message: 'Unknown filter "gone"' },
        { path: 'through', message: 'Unknown filter "also-missing"' },
      ]);
    });

    it.each([
      ['an unknown parameter (a typo)', 'strat=public'],
      ['an unknown parameter next to valid ones', 'start=public&limit=5'],
      ['an empty filter', 'start='],
      ['an upper-case key', 'start=Public'],
      ['a key with a space', 'end=my%20filter'],
      ['a key that starts with a digit', 'through=1abc'],
      ['a key that is too long', `start=${'x'.repeat(64)}`],
      ['bracket syntax', 'start[]=public'],
      ['an object', 'start[a]=public'],
    ])('400 for %s', async (_label, query) => {
      const res = await routes(id, query);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('names the parameter it does not know', async () => {
      const res = await routes(id, 'strat=public&limit=5');

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([
        { path: 'strat', message: 'Unrecognized property "strat"' },
        { path: 'limit', message: 'Unrecognized property "limit"' },
      ]);
    });

    it('400 for more filters in one role than allowed, and accepts exactly the limit', async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => `start=f${i}`).join('&');
      const limit = Array.from({ length: 20 }, () => 'start=public').join('&');

      expect((await routes(id, tooMany)).status).toBe(400);
      expect((await routes(id, limit)).status).toBe(200); // 20 repeats of one filter
    });

    it('404 for an unknown graph and 400 for a malformed id', async () => {
      const unknown = await routes(UNKNOWN_ID, 'start=public');
      const malformed = await routes('nope', 'start=public');

      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe('GRAPH_NOT_FOUND');
      expect(malformed.status).toBe(400);
    });

    it('409 FILTER_UNAVAILABLE for a stored filter whose rule no longer compiles, while other filters still work', async () => {
      await prisma.graphFilter.create({ data: { graphId: id, key: 'broken', definition: { field: 'color', op: 'eq', value: 1 } } });

      const broken = await routes(id, 'start=broken');
      const fine = await routes(id, 'start=public&end=sink');

      expect(broken.status).toBe(409);
      expect(broken.body.error.code).toBe('FILTER_UNAVAILABLE');
      expect(broken.body.error.message).toContain('"broken"');
      expect(fine.status).toBe(200);
      expect(names(fine)).toEqual(['web', 'api', 'db']);
    });
  });

  describe('the answer always reflects the latest data (the cache is dropped after every write)', () => {
    it('after a filter is created, edited and deleted', async () => {
      const id = await createGraph();
      expect((await routes(id, 'start=mine')).status).toBe(400); // not there yet

      await request(app).post(filtersPath(id)).send({ key: 'mine', definition: { field: 'name', op: 'eq', value: 'web' } });
      const created = await routes(id, 'start=mine&end=sink');
      expect(names(created)).toEqual(['web', 'api', 'db']);
      expect(created.body.version).toBe(2);

      await request(app).put(`${filtersPath(id)}/mine`).send({ definition: { field: 'name', op: 'eq', value: 'iso' } });
      const edited = await routes(id, 'start=mine&end=sink');
      expect(edited.body.nodes).toEqual([]);
      expect(edited.body.version).toBe(3);

      await request(app).delete(`${filtersPath(id)}/mine`);
      const deleted = await routes(id, 'start=mine');
      expect(deleted.status).toBe(400);
      expect(deleted.body.error.code).toBe('UNKNOWN_FILTER');
    });

    it('after the graph is replaced: the built-in filters see the new data', async () => {
      const id = await createGraph();
      expect(names(await routes(id, 'start=public&end=sink'))).toEqual(['web', 'api', 'db']);

      await replaceGraph(app, id, graphFile([{ name: 'edge', kind: 'service', publicExposed: true }, { name: 'store', kind: 'sql' }], [{ from: 'edge', to: 'store' }]));

      const res = await routes(id, 'start=public&end=sink');
      expect(names(res)).toEqual(['edge', 'store']);
      expect(edges(res)).toEqual(['edge>store']);
      expect(res.body.version).toBe(2);
    });

    it('after the graph is replaced with one the filters no longer match', async () => {
      const id = await createGraph();
      await routes(id, 'start=public'); // warms the cache

      await replaceGraph(app, id, graphFile([{ name: 'a', kind: 'service' }], []));

      expect((await routes(id, 'start=public')).body.nodes).toEqual([]);
      expect((await routes(id)).body.nodes).toHaveLength(1);
    });

    it('after the graph is deleted', async () => {
      const id = await createGraph();
      expect((await routes(id, 'start=public')).status).toBe(200);

      await request(app).delete(`${GRAPHS}/${id}`);

      expect((await routes(id, 'start=public')).status).toBe(404);
    });

    it('after a rename it still answers (the name is not part of a route)', async () => {
      const id = await createGraph();
      await routes(id, 'start=public');

      await request(app).patch(`${GRAPHS}/${id}`).send({ name: 'renamed' });

      const res = await routes(id, 'start=public&end=sink');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
    });

    it('keeps graphs apart', async () => {
      const first = await createGraph();
      const second = await createGraph(graphFile([{ name: 'solo', kind: 'service', publicExposed: true }], []));

      expect(names(await routes(first, 'start=public'))).toEqual(['web', 'api', 'db', 'cache', 'dead']);
      expect(names(await routes(second, 'start=public'))).toEqual(['solo']);
      await request(app).post(filtersPath(second)).send({ key: 'only-second', definition: { field: 'name', op: 'eq', value: 'solo' } });
      expect((await routes(first, 'start=only-second')).status).toBe(400);
      expect(names(await routes(second, 'start=only-second'))).toEqual(['solo']);
    });
  });

  describe('unknown fields', () => {
    it('are returned on the nodes and on the edges that have them', async () => {
      const id = await createGraph(
        Buffer.from(
          JSON.stringify({
            title: 'ignored here',
            nodes: [
              { name: 'web', kind: 'service', publicExposed: true, owner: 'team-a' },
              { name: 'db', kind: 'rds' },
            ],
            edges: [{ from: 'web', to: 'db', protocol: 'grpc', timeoutMs: 250 }],
          }),
        ),
      );

      const res = await routes(id, 'start=public&end=sink');

      expect(res.body.nodes[0].extra).toEqual({ owner: 'team-a' });
      expect(res.body.edges).toEqual([{ from: 'web', to: 'db', extra: { protocol: 'grpc', timeoutMs: 250 } }]);
    });

    it('can be matched by a filter on "extra"', async () => {
      const id = await createGraph(
        Buffer.from(JSON.stringify({ nodes: [{ name: 'a', kind: 'service', team: 'payments' }, { name: 'b', kind: 'service', team: 'search' }], edges: [{ from: 'a', to: 'b' }] })),
      );
      await request(app).post(filtersPath(id)).send({ key: 'payments-team', definition: { field: 'extra.team', op: 'eq', value: 'payments' } });

      const res = await routes(id, 'start=payments-team');

      expect(names(res)).toEqual(['a', 'b']);
    });
  });

  describe('speed', () => {
    it('serves repeated queries from memory', async () => {
      const id = await createGraph(sampleGraphBuffer());
      await routes(id, 'start=public'); // loads the graph

      const started = performance.now();
      for (let i = 0; i < 30; i += 1) {
        const res = await routes(id, 'through=vulnerable&end=sink');
        expect(res.status).toBe(200);
      }

      expect(performance.now() - started).toBeLessThan(5_000);
    });
  });
});
