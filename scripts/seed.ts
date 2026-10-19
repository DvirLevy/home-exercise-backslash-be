import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadEnv } from '../src/config/env';
import { buildPrismaPersistence, createServices } from '../src/container';
import { createLogger } from '../src/infrastructure/logger';
import { disconnectPrisma, getPrismaClient } from '../src/infrastructure/prisma';
import { parseJsonBuffer } from '../src/modules/graphs/ingestion/upload-parser';

/**
 * Loads a graph file through the normal service code (validation, placeholders, built-in filters).
 *
 *   npm run seed                              # fixtures/train-ticket-be.json
 *   npm run seed -- path/to/graph.json "My graph"
 */
async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = loadEnv();

  const file = resolve(process.argv[2] ?? 'fixtures/train-ticket-be.json');
  const name = process.argv[3] ?? basename(file).replace(/\.json$/i, '');

  const prisma = getPrismaClient(env.DATABASE_URL);
  try {
    const { graphService } = createServices({
      persistence: buildPrismaPersistence(prisma),
      logger: createLogger({ level: 'warn', pretty: false }),
      limits: { maxUploadBytes: env.MAX_UPLOAD_BYTES, maxNodes: env.MAX_NODES, maxEdges: env.MAX_EDGES },
    });
    const { summary, placeholders } = await graphService.create(name, parseJsonBuffer(readFileSync(file)));

    console.log(`Created graph "${summary.name}" (${summary.id})`);
    console.log(`  nodes: ${summary.nodeCount}, edges: ${summary.edgeCount}, version: ${summary.version}`);
    if (placeholders.length > 0) console.log(`  placeholder nodes: ${placeholders.join(', ')}`);
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
