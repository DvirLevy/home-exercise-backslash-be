import type pino from 'pino';
import type { AppDependencies } from './app';
import type { Env } from './config/env';
import { GraphStore } from './graph-engine/graph-store';
import { createLogger, type Logger } from './infrastructure/logger';
import { disconnectPrisma, getPrismaClient, type PrismaClient } from './infrastructure/prisma';
import { graphFileUpload } from './http/middleware/graph-file-upload';
import { buildOpenApiDocument, createOpenApiRegistry } from './http/openapi/registry';
import { FilterController } from './modules/filters/filter.controller';
import type { FilterRepository } from './modules/filters/filter.repository';
import { registerFilterDocs } from './modules/filters/filter.schemas';
import { FilterService } from './modules/filters/filter.service';
import { PrismaFilterRepository } from './modules/filters/prisma-filter.repository';
import type { GraphCache } from './modules/graphs/graph-cache';
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
import { createGraphLoader } from './modules/queries/graph-loader';
import type { LoadedGraph } from './modules/queries/loaded-graph';
import { QueryController } from './modules/queries/query.controller';
import { registerQueryDocs } from './modules/queries/query.schemas';
import { QueryService } from './modules/queries/query.service';
import { createPrismaUnitOfWork, type UnitOfWork } from './modules/unit-of-work';

export interface Repositories {
  health: HealthRepository;
  graphs: GraphRepository;
  filters: FilterRepository;
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
      filters: new PrismaFilterRepository(prisma),
    },
    unitOfWork: createPrismaUnitOfWork(prisma),
  };
}

export interface ServiceOptions {
  persistence: Persistence;
  limits: Limits;
  logger: Logger;
  /** Called, in addition to the store, whenever a write drops a graph from memory. For observers such as tests. */
  graphCache?: GraphCache;
  /** How many graphs the in-memory store keeps (GRAPH_CACHE_MAX_ENTRIES); the store's default when omitted. */
  graphCacheMaxEntries?: number;
}

export interface Services {
  graphService: GraphService;
  filterService: FilterService;
  queryService: QueryService;
  /** The one in-memory cache of query snapshots; every service that reads or invalidates uses this instance. */
  graphStore: GraphStore<LoadedGraph>;
}

/**
 * Business services, built exactly once per application: they share a single graph store, so
 * a write made through one service is seen by every reader.
 */
export function createServices({ persistence, limits, logger, graphCache, graphCacheMaxEntries }: ServiceOptions): Services {
  const graphStore = new GraphStore<LoadedGraph>(
    createGraphLoader({ graphs: persistence.repositories.graphs, filters: persistence.repositories.filters, logger }),
    { maxEntries: graphCacheMaxEntries },
  );
  const cache: GraphCache = {
    invalidate: (graphId) => {
      graphStore.invalidate(graphId);
      graphCache?.invalidate(graphId);
    },
  };

  return {
    graphStore,
    graphService: new GraphService(persistence.repositories.graphs, persistence.unitOfWork, cache, {
      maxNodes: limits.maxNodes,
      maxEdges: limits.maxEdges,
    }),
    filterService: new FilterService(persistence.unitOfWork, graphStore, cache),
    queryService: new QueryService(graphStore),
  };
}

export interface WiringOptions extends ServiceOptions {
  logger: pino.Logger;
  corsOrigins: string[];
}

/**
 * Wires controllers and documentation from already-built infrastructure.
 * Pass the `services` that other code (the seed script) also uses, so there is only one cache.
 */
export function wireApp(options: WiringOptions, services: Services = createServices(options)): AppDependencies {
  const { logger, corsOrigins, persistence, limits } = options;

  const registry = createOpenApiRegistry();
  registerHealthDocs(registry);
  registerGraphDocs(registry);
  registerFilterDocs(registry);
  registerQueryDocs(registry);

  return {
    logger,
    corsOrigins,
    openApiDocument: buildOpenApiDocument(registry),
    healthController: new HealthController(new HealthService(persistence.repositories.health, logger)),
    graphController: new GraphController(services.graphService),
    filterController: new FilterController(services.filterService),
    queryController: new QueryController(services.queryService),
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
  const prisma = getPrismaClient(env.DATABASE_URL); // the single client of this process

  const options: WiringOptions = {
    logger,
    corsOrigins: env.CORS_ORIGINS,
    persistence: buildPrismaPersistence(prisma),
    limits: { maxUploadBytes: env.MAX_UPLOAD_BYTES, maxNodes: env.MAX_NODES, maxEdges: env.MAX_EDGES },
    graphCacheMaxEntries: env.GRAPH_CACHE_MAX_ENTRIES,
  };
  const services = createServices(options);

  return {
    appDependencies: wireApp(options, services),
    services,
    logger,
    prisma,
    dispose: disconnectPrisma,
  };
}
