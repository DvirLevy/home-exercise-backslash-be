import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

// Client-supplied IDs are echoed into logs and headers, so only accept a safe, bounded shape.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
