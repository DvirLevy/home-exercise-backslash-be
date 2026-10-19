import type { RequestHandler } from 'express';
import type { z } from 'zod';

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/**
 * Validates and replaces params/query/body with their parsed values.
 * A ZodError is forwarded to the error handler, which turns it into a 400.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.params) {
      req.params = schemas.params.parse(req.params) as typeof req.params;
    }
    if (schemas.query) {
      // Express 5 exposes req.query as a getter, so it has to be redefined rather than assigned.
      Object.defineProperty(req, 'query', {
        value: schemas.query.parse(req.query),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
    next();
  };
}
