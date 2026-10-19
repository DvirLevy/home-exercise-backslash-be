import type { Express } from 'express';
import request from 'supertest';
import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { PrismaFilterRepository } from '../../../src/modules/filters/prisma-filter.repository';
import { GRAPHS, graphFile, replaceGraph, uploadGraph } from '../../helpers/api';
import { SAMPLE_EXPECTED, sampleGraphBuffer } from '../../helpers/sample-graph-file';
import { customFilter } from '../../helpers/builders';
import { createDatabaseTestApp } from '../../helpers/test-app';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

describe('Graphs API', () => {
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

  /** Uploads the sample and returns the created graph's id. */
  async function createSample(name = 'train-ticket'): Promise<string> {
    const res = await uploadGraph(app, sampleGraphBuffer(), { name, filename: 'train-ticket-be.json' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  describe('POST /api/v1/graphs', () => {
    describe('with the sample file', () => {
      it('returns 201 with the summary, the placeholders, Location and ETag', async () => {
        const res = await uploadGraph(app, sampleGraphBuffer(), { name: 'train-ticket' });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          name: 'train-ticket',
          version: 1,
          nodeCount: SAMPLE_EXPECTED.nodes,
          edgeCount: SAMPLE_EXPECTED.edges,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          placeholders: SAMPLE_EXPECTED.placeholders,
        });
        expect(res.headers.location).toBe(`${GRAPHS}/${res.body.id}`);
        expect(res.headers.etag).toBe('"1"');
      });

      it('stores the three built-in filters, flagged as built-in', async () => {
        const id = await createSample();

        const filters = await prisma.graphFilter.findMany({ where: { graphId: id }, orderBy: { key: 'asc' } });

        expect(filters.map((f) => f.key)).toEqual(['public', 'sink', 'vulnerable']);
        expect(filters.every((f) => f.isBuiltin)).toBe(true);
      });

      it('persists exactly what the file contains', async () => {
        const id = await createSample();

        const res = await request(app).get(`${GRAPHS}/${id}`);
        const byName = new Map((res.body.nodes as Array<Record<string, any>>).map((n) => [n.name, n]));

        expect(res.body.nodes).toHaveLength(47);
        expect(res.body.edges).toHaveLength(98);
        expect(res.body.nodes[0].name).toBe('frontend');
        expect(res.body.edges).toContainEqual({ from: 'consign-service', to: 'consign-price-service' });
        expect(byName.get('frontend')).toMatchObject({ kind: 'service', publicExposed: true, language: 'java', placeholder: false });
        expect(byName.get('auth-service')?.vulnerabilities).toHaveLength(1);
        expect(byName.get('auth-service')?.vulnerabilities[0]).toMatchObject({ severity: 'medium', metadata: { cwe: expect.any(String) } });
        expect(byName.get('prod-postgresdb')).toMatchObject({ kind: 'rds', metadata: { engine: 'postgres', cloud: 'AWS' } });
        expect(byName.get('prod-sqs')?.publicExposed).toBeNull();
      });

      it('creates the missing node as a bare placeholder', async () => {
        const id = await createSample();

        const res = await request(app).get(`${GRAPHS}/${id}`);
        const placeholder = res.body.nodes.find((n: { name: string }) => n.name === 'assurance-service');

        expect(placeholder).toEqual({
          name: 'assurance-service',
          kind: null,
          language: null,
          path: null,
          publicExposed: null,
          placeholder: true,
          vulnerabilities: [],
          metadata: null,
          extra: null,
        });
        expect(res.body.edges).toContainEqual({ from: 'preserve-service', to: 'assurance-service' });
      });
    });

    describe('names', () => {
      it('allows several graphs with the same name', async () => {
        const first = await uploadGraph(app, graphFile(), { name: 'same' });
        const second = await uploadGraph(app, graphFile(), { name: 'same' });

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.body.id).not.toBe(first.body.id);
      });

      it('trims surrounding whitespace', async () => {
        const res = await uploadGraph(app, graphFile(), { name: '  My graph  ' });

        expect(res.body.name).toBe('My graph');
      });

      it.each([
        ['missing', undefined],
        ['blank', '   '],
        ['empty', ''],
        ['too long', 'x'.repeat(201)],
      ])('rejects a name that is %s with 400', async (_label, name) => {
        const res = await uploadGraph(app, graphFile(), { name });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'name' })]);
      });

      it('accepts a name of exactly 200 characters', async () => {
        const res = await uploadGraph(app, graphFile(), { name: 'x'.repeat(200) });

        expect(res.status).toBe(201);
      });
    });

    describe('the file', () => {
      it('rejects a request without a file with 400', async () => {
        const res = await request(app).post(GRAPHS).field('name', 'no file');

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ path: 'file', message: 'Required' }]);
      });

      it('rejects a file sent under another field name with 400', async () => {
        const res = await request(app)
          .post(GRAPHS)
          .field('name', 'x')
          .attach('document', graphFile(), { filename: 'g.json', contentType: 'application/json' });

        expect(res.status).toBe(400);
        expect(res.body.error.details[0].path).toBe('document');
      });

      it('rejects a non-multipart request with 415', async () => {
        const res = await request(app).post(GRAPHS).send({ name: 'x', nodes: [], edges: [] });

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      });

      it.each([
        ['a .csv file', 'data.csv', 'text/csv'],
        ['a .txt file', 'graph.txt', 'text/plain'],
        ['an image', 'graph.png', 'image/png'],
        ['a file without extension', 'graph', 'application/octet-stream'],
      ])('rejects %s with 415', async (_label, filename, contentType) => {
        const res = await uploadGraph(app, graphFile(), { filename, contentType });

        expect(res.status).toBe(415);
        expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      });

      it.each([
        ['an upper-case extension', 'GRAPH.JSON', 'application/octet-stream'],
        ['a JSON content type', 'graph.dat', 'application/json'],
      ])('accepts %s', async (_label, filename, contentType) => {
        const res = await uploadGraph(app, graphFile(), { filename, contentType });

        expect(res.status).toBe(201);
      });

      it('rejects invalid JSON with 400 INVALID_JSON', async () => {
        const res = await uploadGraph(app, Buffer.from('{"nodes": ['));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_JSON');
      });

      it('rejects an empty file with 400', async () => {
        const res = await uploadGraph(app, Buffer.alloc(0));

        expect(res.status).toBe(400);
      });

      it('accepts a file with a UTF-8 byte-order mark', async () => {
        const res = await uploadGraph(app, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), graphFile()]));

        expect(res.status).toBe(201);
      });

      it('rejects a file larger than the configured limit with 413', async () => {
        const small = createDatabaseTestApp(prisma, { limits: { maxUploadBytes: 200 } });

        const res = await uploadGraph(small, sampleGraphBuffer());

        expect(res.status).toBe(413);
        expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
      });

      it('rejects a graph with too many nodes or edges with 413', async () => {
        const tight = createDatabaseTestApp(prisma, { limits: { maxNodes: 2, maxEdges: 10 } });

        const tooManyNodes = await uploadGraph(tight, graphFile([{ name: 'a', kind: 's' }, { name: 'b', kind: 's' }, { name: 'c', kind: 's' }]));
        const tooManyEdges = await uploadGraph(
          createDatabaseTestApp(prisma, { limits: { maxNodes: 10, maxEdges: 1 } }),
          graphFile([{ name: 'a', kind: 's' }], [{ from: 'a', to: ['b', 'c'] }]),
        );

        expect(tooManyNodes.status).toBe(413);
        expect(tooManyEdges.status).toBe(413);
      });
    });

    describe('schema validation', () => {
      it('reports the exact field path of a wrong type', async () => {
        const res = await uploadGraph(
          app,
          graphFile([{ name: 'a', kind: 'service' }, { name: 'b', kind: 'service', publicExposed: 'yes' }]),
        );

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'nodes.1.publicExposed' })]);
      });

      it('rejects nodes without name or kind', async () => {
        const res = await uploadGraph(app, graphFile([{ kind: 'service' }, { name: 'b' }]));

        expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(['nodes.0.name', 'nodes.1.kind']);
      });

      it('rejects a file that is not a graph', async () => {
        const res = await uploadGraph(app, Buffer.from('[1, 2, 3]'));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('rejects an edge "to" of the wrong type', async () => {
        const res = await uploadGraph(app, graphFile([{ name: 'a', kind: 's' }], [{ from: 'a', to: 7 }]));

        expect(res.status).toBe(400);
        expect(res.body.error.details[0]).toMatchObject({ path: 'edges.0.to', message: 'must be a string or an array of strings' });
      });

      it('rejects duplicate node names with 400 and the repeated positions', async () => {
        const res = await uploadGraph(app, graphFile([{ name: 'a', kind: 's' }, { name: 'a', kind: 's' }]));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('DUPLICATE_NODE_NAME');
        expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'nodes.1.name' })]);
      });

      it('rejects a NUL character with 400 instead of failing in the database', async () => {
        const res = await uploadGraph(app, Buffer.from('{"nodes":[{"name":"a\\u0000","kind":"s"}],"edges":[]}'));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_JSON');
      });

      it('stores nothing when validation fails', async () => {
        await uploadGraph(app, graphFile([{ name: 'a' }]));
        await uploadGraph(app, Buffer.from('nope'));

        expect(await prisma.graph.count()).toBe(0);
        expect(await prisma.node.count()).toBe(0);
      });
    });

    describe('what is kept', () => {
      it('keeps unknown node fields in "extra" and returns them', async () => {
        const created = await uploadGraph(
          app,
          graphFile([{ name: 'a', kind: 'service', owner: 'team-a', nested: { list: [1, { deep: true }] } }]),
        );

        const res = await request(app).get(`${GRAPHS}/${created.body.id}`);

        expect(res.body.nodes[0].extra).toEqual({ owner: 'team-a', nested: { list: [1, { deep: true }] } });
      });

      it('accepts and keeps vulnerabilities with any severity string', async () => {
        const created = await uploadGraph(
          app,
          graphFile([{ name: 'a', kind: 'service', vulnerabilities: [{ severity: 'catastrophic', file: 'x', message: 'm', extraField: 1 }] }]),
        );

        const res = await request(app).get(`${GRAPHS}/${created.body.id}`);

        expect(res.body.nodes[0].vulnerabilities).toEqual([{ severity: 'catastrophic', file: 'x', message: 'm', extraField: 1 }]);
      });

      it('merges duplicate edges and keeps self-loops', async () => {
        const created = await uploadGraph(
          app,
          graphFile([{ name: 'a', kind: 's' }, { name: 'b', kind: 's' }], [
            { from: 'a', to: ['b', 'b', 'a'] },
            { from: 'a', to: 'b' },
          ]),
        );

        const res = await request(app).get(`${GRAPHS}/${created.body.id}`);

        expect(created.body.edgeCount).toBe(2);
        expect(res.body.edges).toEqual([{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }]);
      });

      it('accepts a graph with no nodes and no edges', async () => {
        const res = await uploadGraph(app, graphFile([], []));

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ nodeCount: 0, edgeCount: 0, placeholders: [] });
      });
    });
  });

  describe('unknown fields are preserved at every level', () => {
    const awkward = { nested: { list: [1, { deep: true }, null, 'x', false, 0, ''] }, empty: {}, unicode: 'שלום ü', nil: null };
    const richFile = () =>
      Buffer.from(
        JSON.stringify({
          title: 'Train Ticket',
          owner: { team: 'platform' },
          ...awkward,
          nodes: [
            {
              name: 'api',
              kind: 'service',
              language: 'java',
              team: 'a',
              ...awkward,
              metadata: { tier: 1, labels: ['x'] },
              vulnerabilities: [{ file: 'A.java', severity: 'high', message: 'm', metadata: { cwe: 'CWE-1', score: 9.8 }, scanner: 'semgrep', ...awkward }],
            },
            { name: 'db', kind: 'rds', engine: 'postgres' },
          ],
          edges: [
            { from: 'api', to: ['db', 'cache'], protocol: 'grpc', timeoutMs: 250, ...awkward },
            { from: 'db', to: 'api' },
            { from: 'api', to: 'db', retries: 3 }, // duplicate of api>db: its fields are merged in
          ],
        }),
      );

    async function createRich(): Promise<string> {
      const res = await uploadGraph(app, richFile());
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    it('returns the top-level fields as "extra"', async () => {
      const id = await createRich();

      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.body.extra).toEqual({ title: 'Train Ticket', owner: { team: 'platform' }, ...awkward });
    });

    it('returns each node\'s unknown fields as "extra", with the known fields untouched', async () => {
      const id = await createRich();

      const res = await request(app).get(`${GRAPHS}/${id}`);
      const [api, db] = res.body.nodes;

      expect(api).toMatchObject({ name: 'api', kind: 'service', language: 'java', metadata: { tier: 1, labels: ['x'] } });
      expect(api.extra).toEqual({ team: 'a', ...awkward });
      expect(db.extra).toEqual({ engine: 'postgres' });
    });

    it('keeps vulnerabilities whole: known and unknown fields, nested metadata included', async () => {
      const id = await createRich();

      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.body.nodes[0].vulnerabilities).toEqual([
        { file: 'A.java', severity: 'high', message: 'm', metadata: { cwe: 'CWE-1', score: 9.8 }, scanner: 'semgrep', ...awkward },
      ]);
    });

    it('returns each edge\'s unknown fields on every edge its entry expanded to, merged for duplicates', async () => {
      const id = await createRich();

      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.body.edges).toEqual([
        { from: 'api', to: 'cache', extra: { protocol: 'grpc', timeoutMs: 250, ...awkward } },
        { from: 'api', to: 'db', extra: { protocol: 'grpc', timeoutMs: 250, ...awkward, retries: 3 } },
        { from: 'db', to: 'api' }, // no unknown fields: no "extra" key at all
      ]);
    });

    it('does not put "extra" on the edges of a file that has none (the sample)', async () => {
      const id = await createSample();

      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.body.extra).toBeNull();
      expect(res.body.edges.every((e: Record<string, unknown>) => !('extra' in e))).toBe(true);
      expect(res.body.nodes.every((n: { extra: unknown }) => n.extra === null)).toBe(true);
    });

    it('does not let an unknown field overwrite one of ours', async () => {
      const created = await uploadGraph(
        app,
        Buffer.from(
          '{"id":"x","name":"x","version":99,"extra":1,"nodes":[{"name":"a","kind":"s","placeholder":true,"extra":2,"position":5}],"edges":[{"from":"a","to":"a","extra":3,"graphId":"z"}]}',
        ),
        { name: 'real name' },
      );

      const res = await request(app).get(`${GRAPHS}/${created.body.id}`);

      expect(res.body).toMatchObject({ id: created.body.id, name: 'real name', version: 1 });
      expect(res.body.extra).toEqual({ id: 'x', name: 'x', version: 99, extra: 1 });
      expect(res.body.nodes[0]).toMatchObject({ name: 'a', placeholder: false });
      expect(res.body.nodes[0].extra).toEqual({ placeholder: true, extra: 2, position: 5 });
      expect(res.body.edges[0].extra).toEqual({ extra: 3, graphId: 'z' });
    });

    it('stores special-looking keys as ordinary keys', async () => {
      const keys = { constructor: 1, prototype: 2, toString: 3, hasOwnProperty: 4, '': 5, 'with space': 6 };
      const created = await uploadGraph(
        app,
        Buffer.from(JSON.stringify({ ...keys, nodes: [{ name: 'a', kind: 's', ...keys }], edges: [{ from: 'a', to: 'a', ...keys }] })),
      );

      const res = await request(app).get(`${GRAPHS}/${created.body.id}`);

      expect(res.body.extra).toEqual(keys);
      expect(res.body.nodes[0].extra).toEqual(keys);
      expect(res.body.edges[0].extra).toEqual(keys);
    });

    it('refuses a file with a "__proto__" key at any level instead of silently dropping it', async () => {
      for (const text of [
        '{"nodes":[],"edges":[],"__proto__":{"x":1}}',
        '{"nodes":[{"name":"a","kind":"s","__proto__":{"x":1}}],"edges":[]}',
        '{"nodes":[],"edges":[{"from":"a","to":"b","__proto__":1}]}',
        '{"nodes":[{"name":"a","kind":"s","vulnerabilities":[{"__proto__":1}]}],"edges":[]}',
      ]) {
        const res = await uploadGraph(app, Buffer.from(text));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_JSON');
        expect(res.body.error.message).toContain('__proto__');
      }
      expect(await prisma.graph.count()).toBe(0);
    });

    it('replaces the unknown fields of every level on PUT, and clears them when the new file has none', async () => {
      const id = await createRich();

      const swapped = await replaceGraph(
        app,
        id,
        Buffer.from('{"note":"new","nodes":[{"name":"n","kind":"s","tag":"t"}],"edges":[{"from":"n","to":"n","w":1}]}'),
      );
      expect(swapped.status).toBe(200);
      const afterSwap = await request(app).get(`${GRAPHS}/${id}`);
      expect(afterSwap.body.extra).toEqual({ note: 'new' });
      expect(afterSwap.body.nodes).toEqual([expect.objectContaining({ name: 'n', extra: { tag: 't' } })]);
      expect(afterSwap.body.edges).toEqual([{ from: 'n', to: 'n', extra: { w: 1 } }]);

      await replaceGraph(app, id, graphFile([{ name: 'n', kind: 's' }], [{ from: 'n', to: 'n' }]));
      const cleared = await request(app).get(`${GRAPHS}/${id}`);
      expect(cleared.body.extra).toBeNull();
      expect(cleared.body.nodes[0].extra).toBeNull();
      expect(cleared.body.edges).toEqual([{ from: 'n', to: 'n' }]);
    });

    it('keeps the old unknown fields when a replace is rejected', async () => {
      const id = await createRich();

      const res = await replaceGraph(app, id, Buffer.from('{"note":"never stored","nodes":[{"name":"n"}],"edges":[]}'));

      expect(res.status).toBe(400);
      const stored = await request(app).get(`${GRAPHS}/${id}`);
      expect(stored.body.extra).toEqual({ title: 'Train Ticket', owner: { team: 'platform' }, ...awkward });
      expect(stored.body.version).toBe(1);
    });

    it('leaves the unknown fields alone on rename', async () => {
      const id = await createRich();

      await request(app).patch(`${GRAPHS}/${id}`).send({ name: 'renamed' });

      expect((await request(app).get(`${GRAPHS}/${id}`)).body.extra).toEqual({ title: 'Train Ticket', owner: { team: 'platform' }, ...awkward });
    });
  });

  describe('the real content is always validated, whatever the upload claims to be', () => {
    it.each([
      ['an HTML page sent as application/json', '<html><body>hi</body></html>', 'page.json', 'application/json'],
      ['plain text named .json', 'this is not json', 'graph.json', 'application/json'],
      ['binary bytes named .json', '\u0000\u0001\u0002', 'graph.json', 'application/octet-stream'],
      ['a truncated document', '{"nodes":[{"name":"a","kind":"s"}],"edges":[', 'graph.json', 'application/json'],
    ])('rejects %s with 400 INVALID_JSON', async (_label, content, filename, contentType) => {
      const res = await uploadGraph(app, Buffer.from(content, 'latin1'), { filename, contentType });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
      expect(await prisma.graph.count()).toBe(0);
    });

    it.each([
      ['a JSON array', '[{"name":"a","kind":"s"}]'],
      ['a JSON string', '"hello"'],
      ['a JSON number', '42'],
      ['JSON null', 'null'],
      ['an object that is not a graph', '{"hello":"world"}'],
      ['nodes that are not objects', '{"nodes":["a","b"],"edges":[]}'],
      ['nodes that are not a list', '{"nodes":{"a":1},"edges":[]}'],
      ['edges that are not objects', '{"nodes":[],"edges":["a>b"]}'],
    ])('rejects valid JSON that is %s with 400 VALIDATION_ERROR', async (_label, content) => {
      const res = await uploadGraph(app, Buffer.from(content));

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.length).toBeGreaterThan(0);
    });

    it('checks the file name or type first, then still validates what is inside a JSON-looking upload', async () => {
      const wrongName = await uploadGraph(app, graphFile(), { filename: 'graph.txt', contentType: 'text/plain' });
      const rightNameBadContent = await uploadGraph(app, Buffer.from('not json'), { filename: 'graph.json' });

      expect(wrongName.status).toBe(415);
      expect(rightNameBadContent.status).toBe(400);
    });

    it('rejects invalid content on PUT as well', async () => {
      const id = await createSample();

      const res = await replaceGraph(app, id, Buffer.from('<html/>'), { filename: 'g.json', contentType: 'application/json' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
      expect((await request(app).get(`${GRAPHS}/${id}`)).body.version).toBe(1);
    });
  });

  describe('GET /api/v1/graphs', () => {
    it('returns an empty list when there are no graphs', async () => {
      const res = await request(app).get(GRAPHS);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('lists summaries newest first, without nodes or edges', async () => {
      const first = await createSample('first');
      const second = (await uploadGraph(app, graphFile(), { name: 'second' })).body.id;

      const res = await request(app).get(GRAPHS);

      expect(res.status).toBe(200);
      expect(res.body.map((g: { id: string }) => g.id)).toEqual([second, first]);
      expect(res.body[0]).toMatchObject({ name: 'second', version: 1, nodeCount: 1, edgeCount: 0 });
      expect(res.body[1]).toMatchObject({ name: 'first', nodeCount: 47, edgeCount: 98 });
      expect(res.body[0]).not.toHaveProperty('nodes');
      expect(res.body[0]).not.toHaveProperty('edges');
    });
  });

  describe('GET /api/v1/graphs/:id', () => {
    it('returns the graph with an ETag holding its version', async () => {
      const id = await createSample();

      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"1"');
      expect(res.body).toMatchObject({ id, name: 'train-ticket', version: 1 });
      expect(Object.keys(res.body).sort()).toEqual(['edges', 'extra', 'id', 'name', 'nodes', 'version']);
    });

    it('answers 304 to a matching If-None-Match', async () => {
      const id = await createSample();

      const res = await request(app).get(`${GRAPHS}/${id}`).set('If-None-Match', '"1"');

      expect(res.status).toBe(304);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get(`${GRAPHS}/${UNKNOWN_ID}`);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('GRAPH_NOT_FOUND');
    });

    it.each(['not-a-uuid', '123', '0b6c1c8e-6f1e-4a59-9a43-1f3f6c1d2e3'])('returns 400 for the malformed id %p', async (id) => {
      const res = await request(app).get(`${GRAPHS}/${id}`);

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'id' })]);
    });
  });

  describe('PUT /api/v1/graphs/:id', () => {
    const replacement = () =>
      graphFile([{ name: 'x', kind: 'service' }, { name: 'y', kind: 'rds' }], [{ from: 'x', to: ['y', 'ghost'] }]);

    it('replaces the data, bumps the version and reports the placeholders', async () => {
      const id = await createSample();

      const res = await replaceGraph(app, id, replacement());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name: 'train-ticket', version: 2, nodeCount: 3, edgeCount: 2, placeholders: ['ghost'] });
      expect(res.headers.etag).toBe('"2"');

      const stored = await request(app).get(`${GRAPHS}/${id}`);
      expect(stored.body.nodes.map((n: { name: string }) => n.name)).toEqual(['x', 'y', 'ghost']);
      expect(stored.body.edges).toEqual([{ from: 'x', to: 'ghost' }, { from: 'x', to: 'y' }]);
    });

    it('keeps built-in and custom filters', async () => {
      const id = await createSample();
      await new PrismaFilterRepository(prisma).create(id, customFilter('mine'));

      await replaceGraph(app, id, replacement());

      const keys = (await prisma.graphFilter.findMany({ where: { graphId: id }, orderBy: { key: 'asc' } })).map((f) => f.key);
      expect(keys).toEqual(['mine', 'public', 'sink', 'vulnerable']);
    });

    it('renames when a name is sent, and keeps the name otherwise', async () => {
      const id = await createSample('before');

      const kept = await replaceGraph(app, id, replacement());
      const renamed = await replaceGraph(app, id, replacement(), { name: 'after' });

      expect(kept.body.name).toBe('before');
      expect(renamed.body.name).toBe('after');
      expect(renamed.body.version).toBe(3);
    });

    it('rejects a blank name and changes nothing', async () => {
      const id = await createSample();

      const res = await replaceGraph(app, id, replacement(), { name: '   ' });

      expect(res.status).toBe(400);
      expect((await request(app).get(`${GRAPHS}/${id}`)).body.version).toBe(1);
    });

    describe('If-Match', () => {
      it.each(['"1"', '1', 'W/"1"', '*'])('accepts %s for version 1', async (ifMatch) => {
        const id = await createSample();

        const res = await replaceGraph(app, id, replacement(), { ifMatch });

        expect(res.status).toBe(200);
        expect(res.body.version).toBe(2);
      });

      it('returns 409 VERSION_CONFLICT for a stale version and changes nothing', async () => {
        const id = await createSample();
        await replaceGraph(app, id, replacement());

        const res = await replaceGraph(app, id, graphFile([{ name: 'late', kind: 's' }]), { ifMatch: '"1"' });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('VERSION_CONFLICT');
        const stored = await request(app).get(`${GRAPHS}/${id}`);
        expect(stored.body.version).toBe(2);
        expect(stored.body.nodes.map((n: { name: string }) => n.name)).toEqual(['x', 'y', 'ghost']);
      });

      it.each(['abc', '"0"', '"1", "2"'])('returns 400 for the unusable value %p', async (ifMatch) => {
        const id = await createSample();

        const res = await replaceGraph(app, id, replacement(), { ifMatch });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_IF_MATCH');
      });

      it('lets exactly one of two concurrent replaces with the same If-Match win', async () => {
        const id = await createSample();

        const [a, b] = await Promise.all([
          replaceGraph(app, id, graphFile([{ name: 'from-a', kind: 's' }]), { ifMatch: '"1"' }),
          replaceGraph(app, id, graphFile([{ name: 'from-b', kind: 's' }]), { ifMatch: '"1"' }),
        ]);

        expect([a.status, b.status].sort()).toEqual([200, 409]);
        const stored = await request(app).get(`${GRAPHS}/${id}`);
        expect(stored.body.version).toBe(2);
        expect(stored.body.nodes).toHaveLength(1);
      });
    });

    it('leaves the graph untouched when the new file is invalid', async () => {
      const id = await createSample();

      const bad = await replaceGraph(app, id, graphFile([{ name: 'a', kind: 's', publicExposed: 'yes' }]));
      const notJson = await replaceGraph(app, id, Buffer.from('nope'));
      const duplicates = await replaceGraph(app, id, graphFile([{ name: 'a', kind: 's' }, { name: 'a', kind: 's' }]));

      expect([bad.status, notJson.status, duplicates.status]).toEqual([400, 400, 400]);
      const stored = await request(app).get(`${GRAPHS}/${id}`);
      expect(stored.body.version).toBe(1);
      expect(stored.body.nodes).toHaveLength(47);
    });

    it('returns 404 for an unknown graph and 400 for a malformed id', async () => {
      expect((await replaceGraph(app, UNKNOWN_ID, replacement())).status).toBe(404);
      expect((await replaceGraph(app, 'nope', replacement())).status).toBe(400);
    });

    it('rejects a non-multipart body with 415 and a non-JSON file with 415', async () => {
      const id = await createSample();

      const json = await request(app).put(`${GRAPHS}/${id}`).send({ nodes: [], edges: [] });
      const csv = await replaceGraph(app, id, replacement(), { filename: 'g.csv', contentType: 'text/csv' });

      expect([json.status, csv.status]).toEqual([415, 415]);
    });

    it('requires a file', async () => {
      const id = await createSample();

      const res = await request(app).put(`${GRAPHS}/${id}`).field('name', 'only a name');

      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ path: 'file', message: 'Required' }]);
    });
  });

  describe('PATCH /api/v1/graphs/:id', () => {
    it('renames without changing the version or the content', async () => {
      const id = await createSample('old');

      const res = await request(app).patch(`${GRAPHS}/${id}`).send({ name: 'new name' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, name: 'new name', version: 1, nodeCount: 47, edgeCount: 98 });
      expect(res.headers.etag).toBe('"1"');
      expect((await request(app).get(`${GRAPHS}/${id}`)).body.nodes).toHaveLength(47);
    });

    it('trims the new name', async () => {
      const id = await createSample();

      const res = await request(app).patch(`${GRAPHS}/${id}`).send({ name: '  padded  ' });

      expect(res.body.name).toBe('padded');
    });

    it.each([
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['a name over 200 characters', { name: 'x'.repeat(201) }],
      ['a non-string name', { name: 5 }],
      ['no name', {}],
    ])('returns 400 for %s', async (_label, body) => {
      const id = await createSample('keep');

      const res = await request(app).patch(`${GRAPHS}/${id}`).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect((await request(app).get(`${GRAPHS}/${id}`)).body.name).toBe('keep');
    });

    it('returns 400 without a body and 400 for malformed JSON', async () => {
      const id = await createSample();

      expect((await request(app).patch(`${GRAPHS}/${id}`)).status).toBe(400);
      const broken = await request(app).patch(`${GRAPHS}/${id}`).set('Content-Type', 'application/json').send('{"name":');
      expect(broken.status).toBe(400);
      expect(broken.body.error.code).toBe('INVALID_JSON');
    });

    it('returns 404 for an unknown graph and 400 for a malformed id', async () => {
      expect((await request(app).patch(`${GRAPHS}/${UNKNOWN_ID}`).send({ name: 'x' })).status).toBe(404);
      expect((await request(app).patch(`${GRAPHS}/nope`).send({ name: 'x' })).status).toBe(400);
    });
  });

  describe('DELETE /api/v1/graphs/:id', () => {
    it('returns 204 and the graph is gone with its nodes, edges and filters', async () => {
      const id = await createSample();
      const other = await createSample('other');

      const res = await request(app).delete(`${GRAPHS}/${id}`);

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect((await request(app).get(`${GRAPHS}/${id}`)).status).toBe(404);
      expect(await prisma.node.count({ where: { graphId: id } })).toBe(0);
      expect(await prisma.edge.count({ where: { graphId: id } })).toBe(0);
      expect(await prisma.graphFilter.count({ where: { graphId: id } })).toBe(0);
      expect((await request(app).get(`${GRAPHS}/${other}`)).body.nodes).toHaveLength(47);
    });

    it('returns 404 when deleting twice or an unknown graph, and 400 for a malformed id', async () => {
      const id = await createSample();
      await request(app).delete(`${GRAPHS}/${id}`);

      expect((await request(app).delete(`${GRAPHS}/${id}`)).status).toBe(404);
      expect((await request(app).delete(`${GRAPHS}/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await request(app).delete(`${GRAPHS}/nope`)).status).toBe(400);
    });
  });

  describe('cache invalidation', () => {
    it('drops the cache entry after a committed replace or delete, never after a failure', async () => {
      const invalidated: string[] = [];
      const withCache = createDatabaseTestApp(prisma, { graphCache: { invalidate: (id) => void invalidated.push(id) } });
      const id = (await uploadGraph(withCache, graphFile())).body.id as string;
      expect(invalidated).toEqual([]);

      await replaceGraph(withCache, id, graphFile([{ name: 'bad' }])); // invalid: 400
      await replaceGraph(withCache, id, graphFile(), { ifMatch: '"9"' }); // stale: 409
      await request(withCache).patch(`${GRAPHS}/${id}`).send({ name: 'renamed' }); // no effect on results
      expect(invalidated).toEqual([]);

      await replaceGraph(withCache, id, graphFile());
      await request(withCache).delete(`${GRAPHS}/${id}`);
      await request(withCache).delete(`${GRAPHS}/${id}`); // already gone: 404
      expect(invalidated).toEqual([id, id]);
    });
  });

  describe('OpenAPI', () => {
    it('documents every graph endpoint', async () => {
      const res = await request(app).get('/docs/openapi.json');

      const collection = res.body.paths[GRAPHS];
      const item = res.body.paths[`${GRAPHS}/{id}`];
      expect(Object.keys(collection).sort()).toEqual(['get', 'post']);
      expect(Object.keys(item).sort()).toEqual(['delete', 'get', 'patch', 'put']);
    });

    it('describes the upload as multipart with a binary file and the If-Match header', async () => {
      const res = await request(app).get('/docs/openapi.json');

      const upload = res.body.paths[GRAPHS].post.requestBody.content['multipart/form-data'].schema;
      expect(upload.properties.file).toMatchObject({ type: 'string', format: 'binary' });
      expect(upload.required).toEqual(expect.arrayContaining(['file', 'name']));
      const put = res.body.paths[`${GRAPHS}/{id}`].put;
      expect(put.parameters.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(['id', 'if-match']));
      expect(Object.keys(put.responses).sort()).toEqual(['200', '400', '404', '409', '413', '415']);
    });

    it('documents "extra" on the graph and (optionally) on edges', async () => {
      const res = await request(app).get('/docs/openapi.json');

      const detail = res.body.components.schemas.GraphDetail;
      const edge = res.body.components.schemas.GraphEdge;
      expect(detail.required).toEqual(expect.arrayContaining(['extra']));
      expect(edge.properties.extra).toBeDefined();
      expect(edge.required ?? []).not.toContain('extra');
    });

    it('registers the response schemas as components', async () => {
      const res = await request(app).get('/docs/openapi.json');

      expect(Object.keys(res.body.components.schemas)).toEqual(
        expect.arrayContaining(['GraphSummary', 'GraphWriteResult', 'GraphDetail', 'GraphNode', 'GraphEdge', 'ErrorResponse']),
      );
    });
  });
});
