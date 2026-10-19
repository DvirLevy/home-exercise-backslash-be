import type { Router } from 'express';
import request from 'supertest';
import { FilterController } from '../../../src/modules/filters/filter.controller';
import { createFilterRouter } from '../../../src/modules/filters/filter.router';
import { GraphController } from '../../../src/modules/graphs/graph.controller';
import { GRAPHS_PATH } from '../../../src/modules/graphs/graph.schemas';
import { createGraphRouter } from '../../../src/modules/graphs/graph.router';
import { HealthController } from '../../../src/modules/health/health.controller';
import { createHealthRouter } from '../../../src/modules/health/health.router';
import { QueryController } from '../../../src/modules/queries/query.controller';
import { createQueryRouter } from '../../../src/modules/queries/query.router';
import { createDatabaseTestApp } from '../../helpers/test-app';
import { createTestPrisma } from '../../helpers/test-database';

type Operation = `${'get' | 'post' | 'put' | 'patch' | 'delete'} ${string}`;

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** The operations an Express router really serves, as OpenAPI-style "method /prefix/{param}" strings. */
function operationsOf(router: Router, prefix: string): Operation[] {
  return (router as unknown as { stack: RouterLayer[] }).stack.flatMap((layer) => {
    if (!layer.route) return [];
    const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`.replace(/:(\w+)/g, '{$1}');
    return Object.keys(layer.route.methods).map((method) => `${method} ${path}` as Operation);
  });
}

describe('API documentation', () => {
  const prisma = createTestPrisma();
  const app = createDatabaseTestApp(prisma);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Controllers are only used for their handler references here, so they need no services.
  const none = null as never;
  const implemented: Operation[] = [
    ...operationsOf(createHealthRouter(new HealthController(none)), '/health'),
    ...operationsOf(createGraphRouter(new GraphController(none), () => undefined), GRAPHS_PATH),
    ...operationsOf(createFilterRouter(new FilterController(none)), GRAPHS_PATH),
    ...operationsOf(createQueryRouter(new QueryController(none)), GRAPHS_PATH),
  ];

  let documented: Operation[];
  let document: { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };

  beforeAll(async () => {
    document = (await request(app).get('/docs/openapi.json')).body;
    documented = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method} ${path}` as Operation),
    );
  });

  it('knows every endpoint the routers serve (so the comparison below means something)', () => {
    expect(implemented.sort()).toEqual([
      'delete /api/v1/graphs/{id}',
      'delete /api/v1/graphs/{id}/filters/{key}',
      'get /api/v1/graphs',
      'get /api/v1/graphs/{id}',
      'get /api/v1/graphs/{id}/filters',
      'get /api/v1/graphs/{id}/filters/{key}',
      'get /api/v1/graphs/{id}/routes',
      'get /health',
      'patch /api/v1/graphs/{id}',
      'post /api/v1/graphs',
      'post /api/v1/graphs/{id}/filters',
      'post /api/v1/graphs/{id}/filters/preview',
      'put /api/v1/graphs/{id}',
      'put /api/v1/graphs/{id}/filters/{key}',
    ]);
  });

  it('documents every endpoint that is implemented', () => {
    expect(implemented.filter((operation) => !documented.includes(operation))).toEqual([]);
  });

  it('documents nothing that is not implemented', () => {
    expect(documented.filter((operation) => !implemented.includes(operation))).toEqual([]);
  });

  it('only documents endpoints that really answer (none is a "route not found")', async () => {
    const unknownId = '00000000-0000-0000-0000-000000000000';
    for (const operation of documented) {
      const [method, template] = operation.split(' ') as [Exclude<Operation extends `${infer M} ${string}` ? M : never, never>, string];
      const url = template.replace('{id}', unknownId).replace('{key}', 'some-key');

      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);

      expect({ operation, code: res.body?.error?.code }).not.toEqual({ operation, code: 'ROUTE_NOT_FOUND' });
    }
  });

  it('describes the success response of every endpoint, and the client errors of every endpoint that takes input', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const { responses, parameters, requestBody } = operation as { responses: object; parameters?: unknown[]; requestBody?: unknown };
        const codes = Object.keys(responses);
        expect({ path, method, hasSuccess: codes.some((code) => code.startsWith('2')) }).toEqual({ path, method, hasSuccess: true });

        const takesInput = (parameters?.length ?? 0) > 0 || requestBody !== undefined;
        if (takesInput) {
          expect({ path, method, hasClientError: codes.some((code) => code.startsWith('4')) }).toEqual({ path, method, hasClientError: true });
        }
      }
    }
  });

  it('tags every endpoint, so the Swagger UI groups them', () => {
    const tags = new Set<string>();
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        const operationTags = (operation as { tags?: string[] }).tags ?? [];
        expect(operationTags).toHaveLength(1);
        operationTags.forEach((tag) => tags.add(tag));
      }
    }
    expect([...tags].sort()).toEqual(['Filters', 'Graphs', 'Health', 'Routes']);
  });

  it('documents the three query roles of the routes endpoint as optional lists', () => {
    const operation = document.paths['/api/v1/graphs/{id}/routes']!.get as { parameters: Array<{ name: string; in: string; required?: boolean; schema: { type: string } }> };
    const query = operation.parameters.filter((p) => p.in === 'query');

    expect(query.map((p) => p.name).sort()).toEqual(['end', 'start', 'through']);
    expect(query.every((p) => p.required !== true && p.schema.type === 'array')).toBe(true);
  });

  it('documents the filter request bodies, with the rule as a free-form object', () => {
    const post = document.paths['/api/v1/graphs/{id}/filters']!.post as {
      requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown>; required?: string[] } } } };
    };
    const schema = post.requestBody.content['application/json'].schema;

    expect(Object.keys(schema.properties).sort()).toEqual(['definition', 'description', 'key']);
    expect(schema.required).toEqual(expect.arrayContaining(['key']));
  });

  it('registers every response schema as a component', () => {
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining([
        'ErrorResponse', 'HealthReport', 'GraphSummary', 'GraphWriteResult', 'GraphDetail', 'GraphNode', 'GraphEdge',
        'Filter', 'FilterPreview', 'RouteNode', 'RouteResult',
      ]),
    );
  });

  it('serves a valid OpenAPI 3.1 document with an info block', () => {
    const info = (document as unknown as { info: { title: string; version: string } }).info;

    expect(info.title).toBeTruthy();
    expect(info.version).toBeTruthy();
    expect((document as unknown as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('serves the Swagger UI', async () => {
    const res = await request(app).get('/docs/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
