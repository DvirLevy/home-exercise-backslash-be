import { Router } from 'express';
import { validate } from '../../http/middleware/validate';
import { GraphIdParamsSchema } from '../graphs/graph.schemas';
import type { FilterController } from './filter.controller';
import {
  CreateFilterBodySchema,
  FilterParamsSchema,
  PreviewFilterBodySchema,
  ReplaceFilterBodySchema,
} from './filter.schemas';

/** Mounted at /api/v1/graphs, next to the graph router. */
export function createFilterRouter(controller: FilterController): Router {
  const router = Router();
  const graph = { params: GraphIdParamsSchema };
  const filter = { params: FilterParamsSchema };

  router.get('/:id/filters', validate(graph), controller.list);
  router.post('/:id/filters', validate({ ...graph, body: CreateFilterBodySchema }), controller.create);
  router.post('/:id/filters/preview', validate({ ...graph, body: PreviewFilterBodySchema }), controller.preview);
  router.get('/:id/filters/:key', validate(filter), controller.get);
  router.put('/:id/filters/:key', validate({ ...filter, body: ReplaceFilterBodySchema }), controller.replace);
  router.delete('/:id/filters/:key', validate(filter), controller.delete);

  return router;
}
