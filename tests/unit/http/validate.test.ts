import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { validate } from '../../../src/http/middleware/validate';

function makeRequest(parts: { params?: object; query?: object; body?: unknown }): Request {
  const req = { params: parts.params ?? {}, body: parts.body } as unknown as Request;
  // Mirror Express 5, where req.query is a getter.
  Object.defineProperty(req, 'query', { get: () => parts.query ?? {}, configurable: true });
  return req;
}

describe('validate middleware', () => {
  const schemas = {
    params: z.object({ id: z.uuid() }),
    query: z.object({ limit: z.coerce.number().int() }),
    body: z.object({ name: z.string().trim().min(1) }),
  };

  it('replaces params, query and body with parsed values', () => {
    const req = makeRequest({
      params: { id: '0b6c1c8e-6f1e-4a59-9a43-1f3f6c1d2e3a' },
      query: { limit: '5' },
      body: { name: '  graph  ' },
    });
    const next = jest.fn();

    validate(schemas)(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.query).toEqual({ limit: 5 });
    expect(req.body).toEqual({ name: 'graph' });
  });

  it('throws a ZodError for invalid input so the error handler returns 400', () => {
    const req = makeRequest({ params: { id: 'not-a-uuid' } });

    expect(() => validate({ params: schemas.params })(req, {} as Response, jest.fn())).toThrow(ZodError);
  });

  it('leaves parts without a schema untouched', () => {
    const req = makeRequest({ body: { anything: true } });

    validate({})(req, {} as Response, jest.fn());

    expect(req.body).toEqual({ anything: true });
  });
});
