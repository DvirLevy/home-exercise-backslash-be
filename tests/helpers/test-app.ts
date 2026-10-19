import pino from 'pino';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import {
  buildPrismaPersistence,
  wireApp,
  type Limits,
  type Persistence,
  type Repositories,
} from '../../src/container';
import type { PrismaClient } from '../../src/infrastructure/prisma';
import type { GraphCache } from '../../src/modules/graphs/graph-cache';

export const silentLogger = pino({ level: 'silent' });

export const healthyDatabase: Repositories['health'] = { ping: async () => undefined };

export const failingDatabase: Repositories['health'] = {
  ping: async () => {
    throw new Error('connection refused');
  },
};

export const defaultTestLimits: Limits = { maxUploadBytes: 1024 * 1024, maxNodes: 1_000, maxEdges: 10_000 };

/** Storage stand-in for tests that never reach the graph routes: any use fails loudly. */
function unavailable<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, property) => () => {
      throw new Error(`${name}.${String(property)} is not available in this test`);
    },
  });
}

export interface TestAppOptions {
  /** Real or fake storage; defaults to a healthy database and no graph storage. */
  persistence?: Persistence;
  /** Overrides individual repositories of `persistence`. */
  repositories?: Partial<Repositories>;
  corsOrigins?: string[];
  limits?: Partial<Limits>;
  graphCache?: GraphCache;
}

export function createTestApp({
  persistence,
  repositories = {},
  corsOrigins = ['http://localhost:5173'],
  limits = {},
  graphCache,
}: TestAppOptions = {}): Express {
  const base: Persistence = persistence ?? {
    repositories: { health: healthyDatabase, graphs: unavailable('graphs') },
    unitOfWork: unavailable('unitOfWork'),
  };

  return createApp(
    wireApp({
      logger: silentLogger,
      corsOrigins,
      persistence: { ...base, repositories: { ...base.repositories, ...repositories } },
      limits: { ...defaultTestLimits, ...limits },
      ...(graphCache ? { graphCache } : {}),
    }),
  );
}

/** The real app on the real (test-schema) database, as the production wiring builds it. */
export function createDatabaseTestApp(
  prisma: PrismaClient,
  options: Omit<TestAppOptions, 'persistence'> = {},
): Express {
  return createTestApp({ ...options, persistence: buildPrismaPersistence(prisma) });
}
