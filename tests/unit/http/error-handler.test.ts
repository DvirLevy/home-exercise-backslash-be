import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../../src/http/errors';
import { errorHandler, toHttpError } from '../../../src/http/middleware/error-handler';
import type { Logger } from '../../../src/infrastructure/logger';

describe('toHttpError', () => {
  it.each([
    [new ValidationError('bad input'), 400, 'VALIDATION_ERROR'],
    [new NotFoundError('missing'), 404, 'NOT_FOUND'],
    [new ConflictError('stale', 'VERSION_CONFLICT'), 409, 'VERSION_CONFLICT'],
    [new PayloadTooLargeError('too big'), 413, 'PAYLOAD_TOO_LARGE'],
    [new UnsupportedMediaTypeError('not json'), 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('maps %p to its status and code', (error, status, code) => {
    const result = toHttpError(error);

    expect(result.status).toBe(status);
    expect(result.body.error.code).toBe(code);
    expect(result.body.error.message).toBe(error.message);
  });

  it('includes details from an AppError', () => {
    const error = new ValidationError('bad', [{ path: 'nodes.0.name', message: 'Required' }]);

    expect(toHttpError(error).body.error.details).toEqual([{ path: 'nodes.0.name', message: 'Required' }]);
  });

  it('maps a ZodError to 400 with a detail per issue', () => {
    const parsed = z.object({ name: z.string(), count: z.number() }).safeParse({ count: 'x' });
    if (parsed.success) throw new Error('expected a validation failure');

    const result = toHttpError(parsed.error);

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('VALIDATION_ERROR');
    expect(result.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' }),
        expect.objectContaining({ path: 'count' }),
      ]),
    );
  });

  it('maps body-parser errors', () => {
    expect(toHttpError({ type: 'entity.parse.failed', status: 400 })).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_JSON' } },
    });
    expect(toHttpError({ type: 'entity.too.large', status: 413 })).toMatchObject({
      status: 413,
      body: { error: { code: 'PAYLOAD_TOO_LARGE' } },
    });
  });

  it('maps unknown errors to a generic 500 without leaking internals', () => {
    const result = toHttpError(new Error('password=secret at db.ts:42'));

    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    });
  });
});

describe('errorHandler', () => {
  function run(err: unknown) {
    const logger = { error: jest.fn() } as unknown as Logger;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    const req = { id: 'req-1' } as unknown as Request;

    errorHandler(logger)(err, req, res, jest.fn());

    return { logger, res };
  }

  it('responds with the mapped status and body', () => {
    const { res, logger } = run(new NotFoundError('Graph not found'));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Graph not found' } });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs unexpected errors with the request ID', () => {
    const boom = new Error('boom');
    const { res, logger } = run(boom);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledWith({ err: boom, requestId: 'req-1' }, 'Unhandled error');
  });
});
