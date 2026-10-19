import { Router, type RequestHandler } from 'express';
import { validate } from '../../http/middleware/validate';
import type { GraphController } from './graph.controller';
import {
  CreateGraphBodySchema,
  GraphIdParamsSchema,
  RenameGraphBodySchema,
  ReplaceGraphBodySchema,
} from './graph.schemas';

/** Mounted at /api/v1/graphs. `upload` parses the multipart body before validation runs. */
export function createGraphRouter(controller: GraphController, upload: RequestHandler): Router {
  const router = Router();
  const params = { params: GraphIdParamsSchema };

  router.post('/', upload, validate({ body: CreateGraphBodySchema }), controller.create);
  router.get('/', controller.list);
  router.get('/:id', validate(params), controller.get);
  router.put('/:id', validate(params), upload, validate({ body: ReplaceGraphBodySchema }), controller.replace);
  router.patch('/:id', validate({ ...params, body: RenameGraphBodySchema }), controller.rename);
  router.delete('/:id', validate(params), controller.delete);

  return router;
}
