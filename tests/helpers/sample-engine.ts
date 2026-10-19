import { buildSnapshot, type GraphSnapshot } from '../../src/graph-engine/graph-snapshot';
import type { NodePredicate } from '../../src/graph-engine/types';
import { BUILTIN_FILTERS } from '../../src/modules/filters/builtin-filters';
import { compileRule } from '../../src/modules/filters/rules/rule.compiler';
import { parseRule } from '../../src/modules/filters/rules/rule.schema';
import type { EdgeRecord, NodeRecord } from '../../src/modules/graphs/graph.types';
import { parseGraphFile } from '../../src/modules/graphs/ingestion/graph-file.schema';
import { normalizeGraph } from '../../src/modules/graphs/ingestion/graph-normalizer';
import { sampleGraphJson } from './sample-graph-file';

/** The sample file, normalized as an upload would be, with the three built-in filters compiled from their stored rules. */
export function sampleSnapshot(): GraphSnapshot<NodeRecord, EdgeRecord> {
  const { nodes, edges } = normalizeGraph(parseGraphFile(sampleGraphJson()), { maxNodes: 1_000, maxEdges: 1_000 });
  const filters = new Map<string, NodePredicate<NodeRecord>>(
    BUILTIN_FILTERS.map((filter) => [filter.key, compileRule(parseRule(filter.definition))]),
  );
  return buildSnapshot({ id: 'sample', version: 1, nodes, edges }, filters);
}
