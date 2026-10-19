import type { Express } from 'express';
import request from 'supertest';
import type { PrismaClient } from '../../../src/infrastructure/prisma';
import { filtersPath, GRAPHS, graphFile, replaceGraph, routesPath, uploadGraph } from '../../helpers/api';
import { SAMPLE_EXPECTED, sampleGraphBuffer } from '../../helpers/sample-graph-file';
import { createDatabaseTestApp } from '../../helpers/test-app';
import { createTestPrisma, resetDatabase } from '../../helpers/test-database';

/** The whole life of a graph through the API, the way a client would use it. */
describe('End to end: upload, query, add a filter, query, replace, query, delete', () => {
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

  const nodeNames = (res: request.Response): string[] => res.body.nodes.map((n: { name: string }) => n.name);

  it('works from the first upload to the final delete', async () => {
    // 1. Upload the sample file.
    const uploaded = await uploadGraph(app, sampleGraphBuffer(), { name: 'Train Ticket', filename: 'train-ticket-be.json' });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ version: 1, nodeCount: SAMPLE_EXPECTED.nodes, edgeCount: SAMPLE_EXPECTED.edges, placeholders: ['assurance-service'] });
    const id = uploaded.body.id as string;

    // 2. The three built-in filters are there, with their counts.
    const filters = await request(app).get(filtersPath(id));
    expect(filters.body.map((f: { key: string; matchCount: number }) => [f.key, f.matchCount])).toEqual([['public', 2], ['sink', 1], ['vulnerable', 2]]);

    // 3. Public services never reach the database in this architecture.
    const publicToSink = await request(app).get(`${routesPath(id)}?start=public&end=sink`);
    expect(publicToSink.status).toBe(200);
    expect(publicToSink.body.nodes).toEqual([]);

    // 4. But what leads to the database through a vulnerable service is a real result.
    const throughVulnerable = await request(app).get(`${routesPath(id)}?through=vulnerable&end=sink`);
    expect(nodeNames(throughVulnerable)).toEqual(expect.arrayContaining(['order-service', 'auth-service', 'prod-postgresdb']));
    expect(nodeNames(throughVulnerable)).not.toContain('prod-sqs');
    expect(throughVulnerable.body.version).toBe(1);

    // 5. Add a custom filter for the payment services, try it first, then save it.
    const rule = { field: 'name', op: 'contains', value: 'payment' };
    const preview = await request(app).post(`${filtersPath(id)}/preview`).send({ definition: rule });
    expect(preview.body.matches).toEqual(['inside-payment-service', 'payment-service']);
    expect((await request(app).get(`${filtersPath(id)}`)).body).toHaveLength(3); // preview saved nothing

    const created = await request(app).post(filtersPath(id)).send({ key: 'payments', description: 'Payment services', definition: rule });
    expect(created.status).toBe(201);
    expect(created.body.matchCount).toBe(2);
    expect((await request(app).get(`${GRAPHS}/${id}`)).body.version).toBe(2);

    // 6. The new filter works in a query right away (the cache was dropped).
    const fromPayments = await request(app).get(`${routesPath(id)}?start=payments&end=sink`);
    expect(nodeNames(fromPayments)).toEqual(['inside-payment-service', 'order-service', 'prod-postgresdb']); // payment-service is a dead end
    expect(fromPayments.body.version).toBe(2);
    expect(fromPayments.body.nodes[0].matched).toEqual({ roles: ['start'], filters: ['payments'] });

    // 7. Replace the graph with a new file: a public service that reaches a database.
    const replaced = await replaceGraph(
      app,
      id,
      graphFile(
        [
          { name: 'gateway', kind: 'service', publicExposed: true },
          { name: 'payment-api', kind: 'service', publicExposed: false },
          { name: 'ledger', kind: 'sql' },
        ],
        [{ from: 'gateway', to: 'payment-api' }, { from: 'payment-api', to: 'ledger' }],
      ),
      { ifMatch: '"2"', name: 'Payments' },
    );
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: 'Payments', version: 3, nodeCount: 3, edgeCount: 2 });

    // 8. The same queries now see the new data, and the custom filter survived.
    const newPublicToSink = await request(app).get(`${routesPath(id)}?start=public&end=sink`);
    expect(nodeNames(newPublicToSink)).toEqual(['gateway', 'payment-api', 'ledger']);
    expect(newPublicToSink.body.version).toBe(3);
    const newFromPayments = await request(app).get(`${routesPath(id)}?start=payments&end=sink`);
    expect(nodeNames(newFromPayments)).toEqual(['payment-api', 'ledger']); // "payment-api" contains "payment"
    expect(newFromPayments.body.nodes[0].matched).toEqual({ roles: ['start'], filters: ['payments'] });
    const newPayments = await request(app).get(`${filtersPath(id)}/payments`);
    expect(newPayments.body.matchCount).toBe(1);

    // 9. The old version number is refused.
    const stale = await replaceGraph(app, id, graphFile(), { ifMatch: '"2"' });
    expect(stale.status).toBe(409);

    // 10. Delete the graph: everything about it is gone.
    expect((await request(app).delete(`${GRAPHS}/${id}`)).status).toBe(204);
    expect((await request(app).get(`${GRAPHS}/${id}`)).status).toBe(404);
    expect((await request(app).get(`${routesPath(id)}?start=public`)).status).toBe(404);
    expect((await request(app).get(filtersPath(id))).status).toBe(404);
    expect(await prisma.graphFilter.count()).toBe(0);
  });
});
