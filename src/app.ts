import cors from 'cors';
import express, { Router, type Express } from 'express';
import type pino from 'pino';
import { errorHandler } from './http/middleware/error-handler';
import { notFound } from './http/middleware/not-found';
import { requestId } from './http/middleware/request-id';
import { requestLogger } from './http/middleware/request-logger';
import { createDocsRouter } from './http/openapi/docs.router';
import type { OpenApiDocument } from './http/openapi/registry';
import type { HealthController } from './modules/health/health.controller';
import { createHealthRouter } from './modules/health/health.router';

export const API_PREFIX = '/api/v1';
const JSON_BODY_LIMIT = '1mb';

export interface AppDependencies {
  logger: pino.Logger;
  corsOrigins: string[];
  openApiDocument: OpenApiDocument;
  healthController: HealthController;
}

/** Builds the Express app without listening, so tests can drive it with Supertest. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(requestLogger(deps.logger));
  app.use(
    cors({
      origin: deps.corsOrigins,
      exposedHeaders: ['ETag', 'Location', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/health', createHealthRouter(deps.healthController));
  app.use('/docs', createDocsRouter(deps.openApiDocument));

  const api = Router();
  // Feature routers (graphs, filters, routes) are mounted here in later tasks.
  app.use(API_PREFIX, api);

  app.use(notFound());
  app.use(errorHandler(deps.logger));

  return app;
}
