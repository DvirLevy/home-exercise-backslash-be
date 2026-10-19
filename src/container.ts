import type pino from 'pino';
import type { AppDependencies } from './app';
import type { Env } from './config/env';
import { createLogger } from './infrastructure/logger';
import { createPrismaClient, type PrismaClient } from './infrastructure/prisma';
import { graphFileUpload } from './http/middleware/graph-file-upload';
import { buildOpenApiDocument, createOpenApiRegistry } from './http/openapi/registry';
import { type GraphCache, noopGraphCache } from './modules/graphs/graph-cache';
import { GraphController } from './modules/graphs/graph.controller';
import type { GraphRepository } from './modules/graphs/graph.repository';
import { registerGraphDocs } from './modules/graphs/graph.schemas';
import { GraphService } from './modules/graphs/graph.service';
import type { GraphLimits } from './modules/graphs/ingestion/graph-normalizer';
import { PrismaGraphRepository } from './modules/graphs/prisma-graph.repository';
import { HealthController } from './modules/health/health.controller';
import type { HealthRepository } from './modules/health/health.repository';
import { registerHealthDocs } from './modules/health/health.schemas';
import { HealthService } from './modules/health/health.service';
import { PrismaHealthRepository } from './modules/health/prisma-health.repository';
import { createPrismaUnitOfWork, type UnitOfWork } from './modules/unit-of-work';

export interface Repositories {
  health: HealthRepository;
  graphs: GraphRepository;
}

/** Everything that talks to the database: plain repositories plus the transactional unit of work. */
export interface Persistence {
  repositories: Repositories;
  unitOfWork: UnitOfWork;
}

export interface Limits extends GraphLimits {
  maxUploadBytes: number;
}

export function buildPrismaPersistence(prisma: PrismaClient): Persistence {
  return {
    repositories: {
      health: new PrismaHealthRepository(prisma),
      graphs: new PrismaGraphRepository(prisma),
    },
    unitOfWork: createPrismaUnitOfWork(prisma),
  };
}

export interface ServiceOptions {
  persistence: Persistence;
  limits: Limits;
  /** Replaced by the in-memory graph store when the query engine lands. */
  graphCache?: GraphCache;
}

export interface Services {
  graphService: GraphService;
}

/** Business services; also used directly by the seed script. */
export function createServices({ persistence, limits, graphCache = noopGraphCache }: ServiceOptions): Services {
  return {
    graphService: new GraphService(persistence.repositories.graphs, persistence.unitOfWork, graphCache, {
      maxNodes: limits.maxNodes,
      maxEdges: limits.maxEdges,
    }),
  };
}

export interface WiringOptions extends ServiceOptions {
  logger: pino.Logger;
  corsOrigins: string[];
}

/**
 * Wires services and controllers from already-built infrastructure.
 * Tests call this directly with their own persistence.
 */
export function wireApp(options: WiringOptions): AppDependencies {
  const { logger, corsOrigins, persistence, limits } = options;
  const { graphService } = createServices(options);

  const registry = createOpenApiRegistry();
  registerHealthDocs(registry);
  registerGraphDocs(registry);

  return {
    logger,
    corsOrigins,
    openApiDocument: buildOpenApiDocument(registry),
    healthController: new HealthController(new HealthService(persistence.repositories.health, logger)),
    graphController: new GraphController(graphService),
    graphUpload: graphFileUpload({ maxBytes: limits.maxUploadBytes }),
  };
}

export interface Container {
  appDependencies: AppDependencies;
  services: Services;
  logger: pino.Logger;
  prisma: PrismaClient;
  /** Releases infrastructure resources (database connections). */
  dispose(): Promise<void>;
}

/** Composition root: the only place that creates concrete infrastructure. */
export function createContainer(env: Env): Container {
  const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
  const prisma = createPrismaClient(env.DATABASE_URL);

  const options: WiringOptions = {
    logger,
    corsOrigins: env.CORS_ORIGINS,
    persistence: buildPrismaPersistence(prisma),
    limits: { maxUploadBytes: env.MAX_UPLOAD_BYTES, maxNodes: env.MAX_NODES, maxEdges: env.MAX_EDGES },
  };

  return {
    appDependencies: wireApp(options),
    services: createServices(options),
    logger,
    prisma,
    dispose: () => prisma.$disconnect(),
  };
}
