import type pino from 'pino';
import { pinoHttp } from 'pino-http';
import type { RequestHandler } from 'express';

/** Logs one line per request; must run after `requestId()` so logs carry the same ID as the response. */
export function requestLogger(logger: pino.Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: {
      ignore: (req) => req.url === '/health',
    },
  });
}
