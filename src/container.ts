import type pino from 'pino';
import type { AppDependencies } from './app';
import type { Env } from './config/env';
import { createLogger } from './infrastructure/logger';
import { createPrismaClient, type PrismaClient } from './infrastructure/prisma';
import { buildOpenApiDocument, createOpenApiRegistry } from './http/openapi/registry';
import { HealthController } from './modules/health/health.controller';
import type { HealthRepository } from './modules/health/health.repository';
import { registerHealthDocs } from './modules/health/health.schemas';
import { HealthService } from './modules/health/health.service';
import { PrismaHealthRepository } from './modules/health/prisma-health.repository';

export interface Repositories {
  health: HealthRepository;
}

export interface WiringOptions {
  logger: pino.Logger;
  corsOrigins: string[];
  repositories: Repositories;
}

/**
 * Wires services and controllers from already-built infrastructure.
 * Tests call this directly with fake repositories.
 */
export function wireApp({ logger, corsOrigins, repositories }: WiringOptions): AppDependencies {
  const registry = createOpenApiRegistry();
  registerHealthDocs(registry);

  const healthService = new HealthService(repositories.health, logger);

  return {
    logger,
    corsOrigins,
    openApiDocument: buildOpenApiDocument(registry),
    healthController: new HealthController(healthService),
  };
}

export interface Container {
  appDependencies: AppDependencies;
  logger: pino.Logger;
  prisma: PrismaClient;
  /** Releases infrastructure resources (database connections). */
  dispose(): Promise<void>;
}

/** Composition root: the only place that creates concrete infrastructure. */
export function createContainer(env: Env): Container {
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const prisma = createPrismaClient(env.DATABASE_URL);

  const appDependencies = wireApp({
    logger,
    corsOrigins: env.CORS_ORIGINS,
    repositories: {
      health: new PrismaHealthRepository(prisma),
    },
  });

  return {
    appDependencies,
    logger,
    prisma,
    dispose: () => prisma.$disconnect(),
  };
}
