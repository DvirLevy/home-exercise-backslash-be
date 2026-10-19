import type { NewFilter } from '../../src/modules/filters/filter.types';
import type { EdgeRecord, GraphData, NewGraph, NodeRecord } from '../../src/modules/graphs/graph.types';

export function serviceNode(name: string, overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    name,
    kind: 'service',
    language: null,
    path: null,
    publicExposed: null,
    isPlaceholder: false,
    vulnerabilities: [],
    metadata: null,
    extra: null,
    ...overrides,
  };
}

export function placeholderNode(name: string): NodeRecord {
  return serviceNode(name, { kind: null, isPlaceholder: true });
}

export function edge(from: string, to: string, extra: EdgeRecord['extra'] = null): EdgeRecord {
  return { from, to, extra };
}

/**
 * Small graph covering the stored shapes: a public service, a service with a vulnerability and
 * unknown extra fields, a database with metadata, a placeholder, a self-loop, an edge with unknown
 * fields, and unknown top-level fields.
 * Names are deliberately not in alphabetical order so tests can prove file order is kept.
 */
export function sampleGraphData(): GraphData {
  return {
    nodes: [
      serviceNode('web', { language: 'java', path: 'svc/web', publicExposed: true }),
      serviceNode('api', {
        language: 'java',
        publicExposed: false,
        vulnerabilities: [{ file: 'a.java', severity: 'high', message: 'bad', metadata: { cwe: 'CWE-22' } }],
        extra: { owner: 'team-a', tier: 2 },
      }),
      serviceNode('db', { kind: 'rds', metadata: { cloud: 'AWS', engine: 'postgres', version: '9.6' } }),
      placeholderNode('ghost'),
    ],
    edges: [edge('web', 'api'), edge('api', 'db', { latencyMs: 12, tags: ['sync'] }), edge('api', 'ghost'), edge('api', 'api')],
    extra: { source: 'builders', revision: 3 },
  };
}

export function sampleGraph(name = 'sample'): NewGraph {
  return { name, ...sampleGraphData() };
}

export function customFilter(key: string, overrides: Partial<NewFilter> = {}): NewFilter {
  return {
    key,
    description: null,
    definition: { field: 'kind', op: 'eq', value: 'service' },
    isBuiltin: false,
    ...overrides,
  };
}

export function builtinFilters(): NewFilter[] {
  return [
    customFilter('public', { isBuiltin: true, definition: { field: 'publicExposed', op: 'eq', value: true } }),
    customFilter('sink', { isBuiltin: true, definition: { field: 'kind', op: 'in', value: ['rds', 'sql'] } }),
    customFilter('vulnerable', { isBuiltin: true, definition: { field: 'vulnerabilities', op: 'some' } }),
  ];
}
