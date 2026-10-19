import { GraphStore } from '../../src/graph-engine/graph-store';
import { BUILTIN_FILTERS } from '../../src/modules/filters/builtin-filters';
import type { FilterRecord } from '../../src/modules/filters/filter.types';
import type { EdgeRecord, NodeRecord, StoredGraph } from '../../src/modules/graphs/graph.types';
import { createGraphLoader } from '../../src/modules/queries/graph-loader';
import type { LoadedGraph } from '../../src/modules/queries/loaded-graph';
import { edge, serviceNode } from './builders';
import { fakeFilterRepository, fakeGraphRepository, filterRecord, silentTestLogger } from './fakes';

export const GRAPH_ID = '11111111-1111-1111-1111-111111111111';

export const builtinRecords = (): FilterRecord[] =>
  BUILTIN_FILTERS.map((filter) => filterRecord(filter.key, filter.definition, { isBuiltin: true, description: filter.description }));

/** A small graph: web (public) -> api (vulnerable) -> db (rds), plus a dead end and an isolated node. */
export function smallGraph(overrides: Partial<StoredGraph> = {}): StoredGraph {
  const nodes: NodeRecord[] = [
    serviceNode('web', { publicExposed: true }),
    serviceNode('api', { publicExposed: false, vulnerabilities: [{ severity: 'high' }] }),
    serviceNode('db', { kind: 'rds' }),
    serviceNode('dead-end'),
    serviceNode('island'),
  ];
  const edges: EdgeRecord[] = [edge('web', 'api'), edge('api', 'db'), edge('api', 'dead-end')];
  return { id: GRAPH_ID, name: 'small', version: 3, extra: null, nodes, edges, ...overrides };
}

/** A real loader (and store) over fake repositories holding `graph` and `filters`. */
export function storeFor(graph: StoredGraph | null, filters: FilterRecord[] = builtinRecords()) {
  const graphs = fakeGraphRepository({ findWithData: jest.fn(async (_id: string) => graph) });
  const filterRepo = fakeFilterRepository({ list: jest.fn(async (_graphId: string) => [...filters]) });
  const load = createGraphLoader({ graphs, filters: filterRepo, logger: silentTestLogger });
  const loader = jest.fn(load);
  return { store: new GraphStore<LoadedGraph>(loader), loader, graphs, filterRepo };
}
