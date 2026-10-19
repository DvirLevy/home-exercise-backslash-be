import { buildSnapshot } from '../../graph-engine/graph-snapshot';
import type { SnapshotLoader } from '../../graph-engine/graph-store';
import type { NodePredicate } from '../../graph-engine/types';
import type { Logger } from '../../infrastructure/logger';
import type { FilterRepository } from '../filters/filter.repository';
import { CURRENT_DEFINITION_VERSION } from '../filters/filter.types';
import { compileRule } from '../filters/rules/rule.compiler';
import { parseRule } from '../filters/rules/rule.schema';
import type { GraphRepository } from '../graphs/graph.repository';
import type { NodeRecord } from '../graphs/graph.types';
import type { LoadedGraph } from './loaded-graph';

export interface GraphLoaderDependencies {
  graphs: GraphRepository;
  filters: FilterRepository;
  logger: Logger;
}

/**
 * Loads a graph and its filters from PostgreSQL (the source of truth) and turns them into a
 * query snapshot: each stored rule is validated and compiled, then every filter is evaluated
 * once into the index.
 *
 * A stored rule that no longer compiles (a rule-format version this code does not know, or data
 * edited by hand) is skipped and logged, so one bad filter never makes the whole graph unqueryable.
 * Returns null when the graph does not exist.
 */
export function createGraphLoader({ graphs, filters, logger }: GraphLoaderDependencies): SnapshotLoader<LoadedGraph> {
  return async (graphId) => {
    const stored = await graphs.findWithData(graphId);
    if (!stored) return null;

    const records = await filters.list(graphId);
    const predicates = new Map<string, NodePredicate<NodeRecord>>();
    const unusable = new Set<string>();

    for (const record of records) {
      try {
        if (record.definitionVersion !== CURRENT_DEFINITION_VERSION) {
          throw new Error(`Unsupported rule format version ${record.definitionVersion}`);
        }
        predicates.set(record.key, compileRule(parseRule(record.definition)));
      } catch (err) {
        unusable.add(record.key);
        logger.warn({ graphId, filter: record.key, err }, 'Filter skipped: its stored rule does not compile');
      }
    }

    const snapshot = buildSnapshot(
      { id: stored.id, version: stored.version, nodes: stored.nodes, edges: stored.edges },
      predicates,
    );
    return { snapshot, filters: records, unusable };
  };
}
