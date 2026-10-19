import { Router } from 'express';
import { validate } from '../../http/middleware/validate';
import { GraphIdParamsSchema } from '../graphs/graph.schemas';
import type { QueryController } from './query.controller';
import { RouteQueryParamsSchema } from './query.schemas';

/** Mounted at /api/v1/graphs, next to the graph router. */
export function createQueryRouter(controller: QueryController): Router {
  const router = Router();

  router.get('/:id/routes', validate({ params: GraphIdParamsSchema, query: RouteQueryParamsSchema }), controller.routes);

  return router;
}
