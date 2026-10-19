import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { OpenApiDocument } from './registry';

export function createDocsRouter(document: OpenApiDocument): Router {
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });
  router.use('/', swaggerUi.serve, swaggerUi.setup(document));
  return router;
}
