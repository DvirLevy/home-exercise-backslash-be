import { createPrismaClient, type PrismaClient } from '../../src/infrastructure/prisma';
import { toTestDatabaseUrl } from './test-schema';

export { TEST_SCHEMA, toTestDatabaseUrl } from './test-schema';

export function createTestPrisma(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set; tests read it from the .env file');
  return createPrismaClient(toTestDatabaseUrl(databaseUrl));
}

/** Empties every table; CASCADE follows the foreign keys from graphs. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "graphs" CASCADE');
}
