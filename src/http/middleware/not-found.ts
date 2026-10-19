import type { RequestHandler } from 'express';
import { NotFoundError } from '../errors';

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND'));
  };
}
