import request from 'supertest';
import { loadEnv } from '../../../src/config/env';
import { createPrismaClient, type PrismaClient } from '../../../src/infrastructure/prisma';
import { PrismaHealthRepository } from '../../../src/modules/health/prisma-health.repository';
import { createTestApp, failingDatabase } from '../../helpers/test-app';

describe('GET /health', () => {
  describe('with the real PostgreSQL database', () => {
    let prisma: PrismaClient;

    beforeAll(() => {
      prisma = createPrismaClient(loadEnv().DATABASE_URL);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('returns 200 with the database up', async () => {
      const app = createTestApp({ repositories: { health: new PrismaHealthRepository(prisma) } });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    });
  });

  it('returns 503 when the database check fails', async () => {
    const app = createTestApp({ repositories: { health: failingDatabase } });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unavailable', database: 'down' });
  });

  it('returns 503 when the database is unreachable', async () => {
    const unreachable = createPrismaClient('postgresql://nobody:nothing@127.0.0.1:1/none');
    try {
      const app = createTestApp({ repositories: { health: new PrismaHealthRepository(unreachable) } });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.database).toBe('down');
    } finally {
      await unreachable.$disconnect();
    }
  });
});
