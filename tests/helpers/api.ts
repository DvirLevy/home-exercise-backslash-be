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

export const filtersPath = (id: string): string => `${GRAPHS}/${id}/filters`;
export const routesPath = (id: string): string => `${GRAPHS}/${id}/routes`;

/** Nodes with at least one high-severity vulnerability. */
export const HIGH_SEVERITY_RULE = {
  field: 'vulnerabilities',
  op: 'some',
  where: { field: 'severity', op: 'eq', value: 'high' },
} as const;

/**
 * A small graph with a clear shape:  web (public) -> api (vulnerable) -> db (rds), api -> cache (sqs),
 * api -> dead (a dead end), and `iso` with no edges.
 */
export function smallGraphFile(): Buffer {
  return graphFile(
    [
      { name: 'web', kind: 'service', publicExposed: true },
      { name: 'api', kind: 'service', publicExposed: false, vulnerabilities: [{ severity: 'high', file: 'Api.java', message: 'm', metadata: { cwe: 'CWE-22' } }] },
      { name: 'db', kind: 'rds', metadata: { engine: 'postgres' } },
      { name: 'cache', kind: 'sqs' },
      { name: 'dead', kind: 'service' },
      { name: 'iso', kind: 'service' },
    ],
    [
      { from: 'web', to: 'api' },
      { from: 'api', to: ['db', 'cache', 'dead'] },
    ],
  );
}
