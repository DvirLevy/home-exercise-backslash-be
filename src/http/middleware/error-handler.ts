import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../../infrastructure/logger';
import { AppError, type ErrorDetail } from '../errors';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
  };
}

/** A badly broken file can produce thousands of issues; the first ones are enough to fix it. */
const MAX_VALIDATION_DETAILS = 100;

interface HttpErrorShape {
  status: number;
  body: ErrorBody;
}

/** Errors thrown by body-parser carry a `type` and an HTTP status. */
function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

export function toHttpError(err: unknown): HttpErrorShape {
  if (err instanceof AppError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return { status: err.status, body };
  }

  if (err instanceof ZodError) {
    const total = err.issues.length;
    return {
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message:
            total > MAX_VALIDATION_DETAILS
              ? `Request validation failed (showing the first ${MAX_VALIDATION_DETAILS} of ${total} issues)`
              : 'Request validation failed',
          details: err.issues
            .slice(0, MAX_VALIDATION_DETAILS)
            .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      },
    };
  }

  if (isBodyParserError(err)) {
    if (err.type === 'entity.parse.failed') {
      return { status: 400, body: { error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } } };
    }
    if (err.type === 'entity.too.large') {
      return { status: 413, body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } } };
    }
  }

  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } };
}

/** Converts every error into the shared error format; stack traces are logged, never returned. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const { status, body } = toHttpError(err);
    if (status >= 500) {
      logger.error({ err, requestId: req.id }, 'Unhandled error');
    }
    res.status(status).json(body);
  };
}
