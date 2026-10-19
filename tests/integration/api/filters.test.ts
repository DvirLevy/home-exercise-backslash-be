import type { Express } from 'express';
import request from 'supertest';
import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { PrismaFilterRepository } from '../../../src/modules/filters/prisma-filter.repository';
import { MAX_FILTERS_PER_GRAPH } from '../../../src/modules/filters/filter.types';
import { filtersPath, GRAPHS, graphFile, HIGH_SEVERITY_RULE, replaceGraph, smallGraphFile, uploadGraph } from '../../helpers/api';
import { customFilter } from '../../helpers/builders';
import { sampleGraphBuffer } from '../../helpers/sample-graph-file';
import { createDatabaseTestApp } from '../../helpers/test-app';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';
const nameIsWeb = { field: 'name', op: 'eq', value: 'web' };

describe('Filters API', () => {
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
  const version = async (id: string): Promise<number> => (await request(app).get(`${GRAPHS}/${id}`)).body.version;
  const storedFilterCount = (id: string) => prisma.graphFilter.count({ where: { graphId: id } });
  const post = (id: string, body: unknown) => request(app).post(filtersPath(id)).send(body as object);

  describe('GET /graphs/:id/filters', () => {
    it('lists the three built-in filters with their match counts on the sample', async () => {
      const id = await createGraph(sampleGraphBuffer());

      const res = await request(app).get(filtersPath(id));

      expect(res.status).toBe(200);
      expect(res.body.map((f: { key: string; matchCount: number; builtin: boolean }) => [f.key, f.matchCount, f.builtin])).toEqual([
        ['public', 2, true],
        ['sink', 1, true],
        ['vulnerable', 2, true],
      ]);
    });

    it('describes each filter with its rule', async () => {
      const id = await createGraph();

      const res = await request(app).get(filtersPath(id));

      expect(res.body[0]).toEqual({
        key: 'public',
        description: expect.any(String),
        builtin: true,
        definition: { field: 'publicExposed', op: 'eq', value: true },
        matchCount: 1,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(res.body[1].definition).toEqual({ field: 'kind', op: 'in', value: ['rds', 'sql'] });
      expect(res.body[2].definition).toEqual({ field: 'vulnerabilities', op: 'some' });
    });

    it('lists custom filters after the built-in ones, ordered by key', async () => {
      const id = await createGraph();
      await post(id, { key: 'zebra', definition: nameIsWeb });
      await post(id, { key: 'alpha', definition: nameIsWeb });

      const res = await request(app).get(filtersPath(id));

      expect(res.body.map((f: { key: string }) => f.key)).toEqual(['public', 'sink', 'vulnerable', 'alpha', 'zebra']);
    });

    it('returns 404 for an unknown graph and 400 for a malformed id', async () => {
      expect((await request(app).get(filtersPath(UNKNOWN_ID))).status).toBe(404);
      expect((await request(app).get(filtersPath('nope'))).status).toBe(400);
    });

    it('recomputes the counts when the graph is replaced', async () => {
      const id = await createGraph();
      await replaceGraph(app, id, graphFile([{ name: 'a', kind: 'service', publicExposed: true }, { name: 'b', kind: 'service', publicExposed: true }, { name: 'c', kind: 'rds' }]));

      const res = await request(app).get(filtersPath(id));

      expect(res.body.map((f: { key: string; matchCount: number }) => [f.key, f.matchCount])).toEqual([['public', 2], ['sink', 1], ['vulnerable', 0]]);
    });
  });

  describe('GET /graphs/:id/filters/:key', () => {
    it('returns one filter', async () => {
      const id = await createGraph();

      const res = await request(app).get(`${filtersPath(id)}/sink`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: 'sink', builtin: true, matchCount: 1 });
    });

    it('returns 404 for an unknown key (or graph) and 400 for a malformed key or id', async () => {
      const id = await createGraph();

      const unknownKey = await request(app).get(`${filtersPath(id)}/nope`);
      expect(unknownKey.status).toBe(404);
      expect(unknownKey.body.error.code).toBe('FILTER_NOT_FOUND');
      expect((await request(app).get(`${filtersPath(UNKNOWN_ID)}/public`)).status).toBe(404);
      expect((await request(app).get(`${filtersPath(id)}/Bad_Key`)).status).toBe(400);
      expect((await request(app).get(`${filtersPath('nope')}/public`)).status).toBe(400);
    });
  });

  describe('POST /graphs/:id/filters', () => {
    it('creates a custom filter and returns 201 with its location and match count', async () => {
      const id = await createGraph();

      const res = await post(id, { key: 'high-severity', description: 'High severity only', definition: HIGH_SEVERITY_RULE });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`${filtersPath(id)}/high-severity`);
      expect(res.body).toMatchObject({
        key: 'high-severity',
        description: 'High severity only',
        builtin: false,
        definition: HIGH_SEVERITY_RULE,
        matchCount: 1, // api
      });
    });

    it('finds only order-service for a high-severity filter on the sample (auth-service is medium)', async () => {
      const id = await createGraph(sampleGraphBuffer());

      const res = await post(id, { key: 'high-severity', definition: HIGH_SEVERITY_RULE });
      const preview = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: HIGH_SEVERITY_RULE });

      expect(res.body.matchCount).toBe(1);
      expect(preview.body.matches).toEqual(['order-service']);
    });

    it('increases the graph version by one', async () => {
      const id = await createGraph();
      expect(await version(id)).toBe(1);

      await post(id, { key: 'one', definition: nameIsWeb });
      expect(await version(id)).toBe(2);

      await post(id, { key: 'two', definition: nameIsWeb });
      expect(await version(id)).toBe(3);
    });

    it('stores an empty or missing description as null and trims the rest', async () => {
      const id = await createGraph();

      const none = await post(id, { key: 'a', definition: nameIsWeb });
      const empty = await post(id, { key: 'b', description: '', definition: nameIsWeb });
      const nulled = await post(id, { key: 'c', description: null, definition: nameIsWeb });
      const padded = await post(id, { key: 'd', description: '  hi  ', definition: nameIsWeb });

      expect([none, empty, nulled].map((r) => r.body.description)).toEqual([null, null, null]);
      expect(padded.body.description).toBe('hi');
    });

    it('accepts rules that use every kind of field', async () => {
      const id = await createGraph();
      const rule = {
        all: [
          { field: 'kind', op: 'in', value: ['rds', 'sql'] },
          { not: { field: 'publicExposed', op: 'eq', value: true } },
          { field: 'metadata.engine', op: 'contains', value: 'postgres' },
        ],
      };

      const res = await post(id, { key: 'postgres-sinks', definition: rule });

      expect(res.status).toBe(201);
      expect(res.body.matchCount).toBe(1);
    });

    describe('is refused', () => {
      it.each([
        ['an existing built-in key', 'public'],
        ['another built-in key', 'sink'],
      ])('409 FILTER_KEY_EXISTS for %s', async (_label, key) => {
        const id = await createGraph();

        const res = await post(id, { key, definition: nameIsWeb });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FILTER_KEY_EXISTS');
      });

      it('409 FILTER_KEY_EXISTS for a custom key used twice', async () => {
        const id = await createGraph();
        await post(id, { key: 'mine', definition: nameIsWeb });

        const res = await post(id, { key: 'mine', definition: { field: 'name', op: 'eq', value: 'api' } });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FILTER_KEY_EXISTS');
        expect((await request(app).get(`${filtersPath(id)}/mine`)).body.definition).toEqual(nameIsWeb); // untouched
      });

      it.each(['', 'Upper', 'with space', '1starts-with-digit', 'under_score', '-lead', 'trail-', 'x'.repeat(64), 'ünï', 'a/b', 'preview '])(
        '400 for the key %p',
        async (key) => {
          const id = await createGraph();

          const res = await post(id, { key, definition: nameIsWeb });

          expect(res.status).toBe(400);
          expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'key' })]);
        },
      );

      it.each([
        ['an unknown field', { field: 'color', op: 'eq', value: 'red' }, 'definition.field'],
        ['an unknown operator', { field: 'kind', op: 'equals', value: 'rds' }, 'definition.op'],
        ['a value of the wrong type', { field: 'kind', op: 'in', value: 'rds' }, 'definition.value'],
        ['a missing value', { field: 'kind', op: 'eq' }, 'definition.value'],
        ['an empty all', { all: [] }, 'definition.all'],
        ['"vulnerabilities" without some', { field: 'vulnerabilities', op: 'exists' }, 'definition.field'],
        ['a problem inside where', { field: 'vulnerabilities', op: 'some', where: { field: 'severity', op: 'gt', value: 'x' } }, 'definition.where.value'],
        ['a rule that is not an object', 'public', 'definition'],
        ['a rule that is an array', [{ field: 'kind', op: 'eq', value: 'x' }], 'definition'],
      ])('400 INVALID_FILTER_RULE for %s, pointing at %s', async (_label, definition, path) => {
        const id = await createGraph();

        const res = await post(id, { key: 'bad', definition });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_FILTER_RULE');
        expect(res.body.error.details).toEqual([expect.objectContaining({ path })]);
      });

      it('400 when the definition is missing (VALIDATION_ERROR) and for a rule nested too deep (INVALID_FILTER_RULE)', async () => {
        const id = await createGraph();
        let deep: unknown = nameIsWeb;
        for (let i = 0; i < 12; i += 1) deep = { not: deep };

        const missing = await post(id, { key: 'bad' });
        const tooDeep = await post(id, { key: 'deep', definition: deep });

        expect(missing.status).toBe(400);
        expect(missing.body.error.code).toBe('VALIDATION_ERROR');
        expect(missing.body.error.details).toEqual([expect.objectContaining({ path: 'definition' })]);
        expect(tooDeep.body.error.code).toBe('INVALID_FILTER_RULE');
        expect(tooDeep.body.error.details[0].message).toContain('deeper');
      });

      it('400 for a property it does not know, a non-string description, or a body that is not JSON', async () => {
        const id = await createGraph();

        const unknown = await post(id, { key: 'a', definition: nameIsWeb, rule: 1 });
        const description = await post(id, { key: 'b', definition: nameIsWeb, description: 5 });
        const notJson = await request(app).post(filtersPath(id)).set('Content-Type', 'application/json').send('{"key":');
        const noBody = await request(app).post(filtersPath(id));

        expect([unknown.status, description.status, notJson.status, noBody.status]).toEqual([400, 400, 400, 400]);
        expect(notJson.body.error.code).toBe('INVALID_JSON');
      });

      it('and leaves the version and the filters untouched', async () => {
        const id = await createGraph();

        await post(id, { key: 'public', definition: nameIsWeb }); // duplicate
        await post(id, { key: 'bad', definition: { field: 'color', op: 'eq', value: 1 } }); // bad rule
        await post(id, { key: 'Bad Key', definition: nameIsWeb }); // bad key

        expect(await version(id)).toBe(1);
        expect(await storedFilterCount(id)).toBe(3);
      });

      it('404 for an unknown graph, and 400 for a malformed id', async () => {
        expect((await post(UNKNOWN_ID, { key: 'a', definition: nameIsWeb })).status).toBe(404);
        expect((await post('nope', { key: 'a', definition: nameIsWeb })).status).toBe(400);
      });

      it('409 FILTER_LIMIT_REACHED once a graph holds the maximum number of filters', async () => {
        const id = await createGraph();
        const filters = new PrismaFilterRepository(prisma);
        await filters.createMany(id, Array.from({ length: MAX_FILTERS_PER_GRAPH - 3 }, (_, i) => customFilter(`bulk-${i}`)));
        expect(await storedFilterCount(id)).toBe(MAX_FILTERS_PER_GRAPH);

        const res = await post(id, { key: 'one-too-many', definition: nameIsWeb });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FILTER_LIMIT_REACHED');
        expect(await version(id)).toBe(1);
      });
    });

    it('lets exactly one of two concurrent creates of the same key win', async () => {
      const id = await createGraph();

      const [a, b] = await Promise.all([
        post(id, { key: 'race', definition: nameIsWeb }),
        post(id, { key: 'race', definition: { field: 'name', op: 'eq', value: 'api' } }),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await version(id)).toBe(2); // only the winner bumped it
    });

    it('counts every one of several concurrent creates of different keys in the version', async () => {
      const id = await createGraph();

      const results = await Promise.all(['a', 'b', 'c', 'd'].map((key) => post(id, { key, definition: nameIsWeb })));

      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(await version(id)).toBe(5);
      expect((await request(app).get(filtersPath(id))).body).toHaveLength(7);
    });
  });

  describe('PUT /graphs/:id/filters/:key', () => {
    it('replaces the rule and the description, keeps the key, and updates the match count', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', description: 'old', definition: nameIsWeb });

      const res = await request(app)
        .put(`${filtersPath(id)}/mine`)
        .send({ description: 'new', definition: { field: 'kind', op: 'eq', value: 'service' } });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ key: 'mine', description: 'new', builtin: false, definition: { field: 'kind', op: 'eq', value: 'service' }, matchCount: 4 });
      expect((await request(app).get(`${filtersPath(id)}/mine`)).body.matchCount).toBe(4);
    });

    it('moves updatedAt forward but not createdAt', async () => {
      const id = await createGraph();
      const created = (await post(id, { key: 'mine', definition: nameIsWeb })).body;
      await new Promise((resolve) => setTimeout(resolve, 15));

      const updated = (await request(app).put(`${filtersPath(id)}/mine`).send({ definition: nameIsWeb })).body;

      expect(updated.createdAt).toBe(created.createdAt);
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    });

    it('clears the description when none is sent (PUT replaces the whole filter)', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', description: 'something', definition: nameIsWeb });

      const res = await request(app).put(`${filtersPath(id)}/mine`).send({ definition: nameIsWeb });

      expect(res.body.description).toBeNull();
    });

    it('increases the graph version', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb });
      const before = await version(id);

      await request(app).put(`${filtersPath(id)}/mine`).send({ definition: nameIsWeb });

      expect(await version(id)).toBe(before + 1);
    });

    it('refuses to change a built-in filter (409) and leaves it and the version alone', async () => {
      const id = await createGraph();

      const res = await request(app).put(`${filtersPath(id)}/public`).send({ definition: nameIsWeb });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BUILTIN_FILTER_READ_ONLY');
      expect((await request(app).get(`${filtersPath(id)}/public`)).body.definition).toEqual({ field: 'publicExposed', op: 'eq', value: true });
      expect(await version(id)).toBe(1);
    });

    it('returns 404 for an unknown filter or graph, 400 for an invalid rule, and does not bump the version', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb });
      const before = await version(id);

      const unknownFilter = await request(app).put(`${filtersPath(id)}/nope`).send({ definition: nameIsWeb });
      const unknownGraph = await request(app).put(`${filtersPath(UNKNOWN_ID)}/mine`).send({ definition: nameIsWeb });
      const badRule = await request(app).put(`${filtersPath(id)}/mine`).send({ definition: { field: 'color', op: 'eq', value: 1 } });
      const keyInBody = await request(app).put(`${filtersPath(id)}/mine`).send({ key: 'renamed', definition: nameIsWeb });

      expect([unknownFilter.status, unknownGraph.status, badRule.status, keyInBody.status]).toEqual([404, 404, 400, 400]);
      expect(badRule.body.error.code).toBe('INVALID_FILTER_RULE');
      expect(await version(id)).toBe(before);
      expect((await request(app).get(`${filtersPath(id)}/mine`)).body.definition).toEqual(nameIsWeb);
    });
  });

  describe('DELETE /graphs/:id/filters/:key', () => {
    it('removes a custom filter (204) and increases the version', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb });
      const before = await version(id);

      const res = await request(app).delete(`${filtersPath(id)}/mine`);

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect((await request(app).get(`${filtersPath(id)}/mine`)).status).toBe(404);
      expect(await version(id)).toBe(before + 1);
      expect(await storedFilterCount(id)).toBe(3);
    });

    it.each(['public', 'sink', 'vulnerable'])('refuses to delete the built-in filter %s (409)', async (key) => {
      const id = await createGraph();

      const res = await request(app).delete(`${filtersPath(id)}/${key}`);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BUILTIN_FILTER_READ_ONLY');
      expect(await storedFilterCount(id)).toBe(3);
      expect(await version(id)).toBe(1);
    });

    it('returns 404 for an unknown filter, a second delete, or an unknown graph, and 400 for a malformed key', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb });
      await request(app).delete(`${filtersPath(id)}/mine`);
      const before = await version(id);

      expect((await request(app).delete(`${filtersPath(id)}/mine`)).status).toBe(404);
      expect((await request(app).delete(`${filtersPath(id)}/nope`)).status).toBe(404);
      expect((await request(app).delete(`${filtersPath(UNKNOWN_ID)}/mine`)).status).toBe(404);
      expect((await request(app).delete(`${filtersPath(id)}/Bad Key`)).status).toBe(400);
      expect(await version(id)).toBe(before);
    });

    it('goes away with its graph', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb });

      await request(app).delete(`${GRAPHS}/${id}`);

      expect(await storedFilterCount(id)).toBe(0);
      expect((await request(app).get(filtersPath(id))).status).toBe(404);
    });
  });

  describe('POST /graphs/:id/filters/preview', () => {
    it('returns the names of the nodes a rule would match, in file order', async () => {
      const id = await createGraph();

      const res = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: { field: 'kind', op: 'eq', value: 'service' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ matchCount: 4, matches: ['web', 'api', 'dead', 'iso'] });
    });

    it('matches nothing without failing for a rule nobody satisfies', async () => {
      const id = await createGraph();

      const res = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: { field: 'name', op: 'eq', value: 'zzz' } });

      expect(res.body).toEqual({ matchCount: 0, matches: [] });
    });

    it('never lists a placeholder', async () => {
      const id = await createGraph(graphFile([{ name: 'a', kind: 'service' }], [{ from: 'a', to: 'ghost' }]));

      const res = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: { field: 'name', op: 'exists' } });

      expect(res.body.matches).toEqual(['a']);
    });

    it('saves nothing and does not change the version', async () => {
      const id = await createGraph();

      await request(app).post(`${filtersPath(id)}/preview`).send({ definition: nameIsWeb });
      await request(app).post(`${filtersPath(id)}/preview`).send({ definition: HIGH_SEVERITY_RULE });

      expect(await storedFilterCount(id)).toBe(3);
      expect(await version(id)).toBe(1);
      expect((await request(app).get(filtersPath(id))).body).toHaveLength(3);
    });

    it('returns 400 INVALID_FILTER_RULE for an invalid rule, 404 for an unknown graph, 400 for a malformed id', async () => {
      const id = await createGraph();

      const bad = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: { field: 'color', op: 'eq', value: 1 } });
      const missing = await request(app).post(`${filtersPath(id)}/preview`).send({});
      const unknown = await request(app).post(`${filtersPath(UNKNOWN_ID)}/preview`).send({ definition: nameIsWeb });
      const malformed = await request(app).post(`${filtersPath('nope')}/preview`).send({ definition: nameIsWeb });

      expect([bad.status, missing.status, unknown.status, malformed.status]).toEqual([400, 400, 404, 400]);
      expect(bad.body.error.code).toBe('INVALID_FILTER_RULE');
      expect(missing.body.error.code).toBe('VALIDATION_ERROR');
      expect(missing.body.error.details).toEqual([expect.objectContaining({ path: 'definition' })]);
    });

    it('lets a custom filter be called "preview" without getting in the way of the preview endpoint', async () => {
      const id = await createGraph();
      await post(id, { key: 'preview', definition: nameIsWeb });

      expect((await request(app).get(`${filtersPath(id)}/preview`)).body.key).toBe('preview');
      const res = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: nameIsWeb });
      expect(res.body.matches).toEqual(['web']);
    });
  });

  describe('versions and the graph', () => {
    it('makes a replace that still carries the old version fail with 409 after a filter changed', async () => {
      const id = await createGraph();
      await post(id, { key: 'mine', definition: nameIsWeb }); // version 1 -> 2

      const res = await replaceGraph(app, id, smallGraphFile(), { ifMatch: '"1"' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('keeps custom filters when the graph is replaced, and evaluates them on the new data', async () => {
      const id = await createGraph();
      await post(id, { key: 'high-severity', definition: HIGH_SEVERITY_RULE });

      await replaceGraph(app, id, graphFile([{ name: 'x', kind: 'service', vulnerabilities: [{ severity: 'high' }] }, { name: 'y', kind: 'service', vulnerabilities: [{ severity: 'high' }] }]));

      const res = await request(app).get(`${filtersPath(id)}/high-severity`);
      expect(res.body.matchCount).toBe(2);
    });
  });

  describe('a stored rule that no longer compiles', () => {
    async function withBrokenFilter() {
      const id = await createGraph();
      // Written straight to the database, past the API's validation (e.g. by hand, or by a newer version).
      await prisma.graphFilter.create({ data: { graphId: id, key: 'broken', definition: { field: 'color', op: 'eq', value: 1 } } });
      await prisma.graphFilter.create({ data: { graphId: id, key: 'from-the-future', definition: nameIsWeb, definitionVersion: 99 } });
      return id;
    }

    it('does not stop the graph or the other filters from working; its count is null', async () => {
      const id = await withBrokenFilter();

      const res = await request(app).get(filtersPath(id));

      expect(res.status).toBe(200);
      const counts = Object.fromEntries(res.body.map((f: { key: string; matchCount: number | null }) => [f.key, f.matchCount]));
      expect(counts).toEqual({ public: 1, sink: 1, vulnerable: 1, broken: null, 'from-the-future': null });
    });

    it('can be repaired with a valid rule', async () => {
      const id = await withBrokenFilter();

      const res = await request(app).put(`${filtersPath(id)}/broken`).send({ definition: nameIsWeb });

      expect(res.status).toBe(200);
      expect(res.body.matchCount).toBe(1);
    });

    it('can be deleted', async () => {
      const id = await withBrokenFilter();

      expect((await request(app).delete(`${filtersPath(id)}/broken`)).status).toBe(204);
    });
  });
});
