import type { Express } from 'express';
import request from 'supertest';

export const GRAPHS = '/api/v1/graphs';

/** Minimal valid graph file as a Buffer. */
export function graphFile(
  nodes: Array<Record<string, unknown>> = [{ name: 'a', kind: 'service' }],
  edges: Array<Record<string, unknown>> = [],
): Buffer {
  return Buffer.from(JSON.stringify({ nodes, edges }));
}

export interface UploadOptions {
  name?: string | undefined;
  filename?: string;
  contentType?: string;
}

/** POST a graph file as multipart/form-data. Pass `name: undefined` explicitly to omit the field. */
export function uploadGraph(app: Express, file: Buffer, options: UploadOptions = {}) {
  const { filename = 'graph.json', contentType = 'application/json' } = options;
  const name = 'name' in options ? options.name : 'test graph';
  const req = request(app).post(GRAPHS);
  if (name !== undefined) req.field('name', name);
  return req.attach('file', file, { filename, contentType });
}

/** PUT a replacement graph file, optionally with an If-Match header. */
export function replaceGraph(
  app: Express,
  id: string,
  file: Buffer,
  { name, ifMatch, filename = 'graph.json', contentType = 'application/json' }: UploadOptions & { ifMatch?: string } = {},
) {
  const req = request(app).put(`${GRAPHS}/${id}`);
  if (ifMatch !== undefined) req.set('If-Match', ifMatch);
  if (name !== undefined) req.field('name', name);
  return req.attach('file', file, { filename, contentType });
}
