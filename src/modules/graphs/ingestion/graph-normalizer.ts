import { PayloadTooLargeError, ValidationError, type ErrorDetail } from '../../../http/errors';
import type { JsonObject } from '../../../shared/json';
import type { EdgeRecord, GraphData, NodeRecord } from '../graph.types';
import type { FileNode, GraphFile } from './graph-file.schema';

export interface GraphLimits {
  maxNodes: number;
  maxEdges: number;
}

export interface NormalizedGraph extends GraphData {
  /** Names that edges referenced but the file never defined; they were added as placeholder nodes. */
  placeholders: string[];
}

const MAX_REPORTED_DUPLICATES = 50;

function toNodeRecord(node: FileNode): NodeRecord {
  return { ...node, isPlaceholder: false };
}

function toPlaceholder(name: string): NodeRecord {
  return {
    name,
    kind: null,
    language: null,
    path: null,
    publicExposed: null,
    isPlaceholder: true,
    vulnerabilities: [],
    metadata: null,
    extra: null,
  };
}

/**
 * Combines the unknown fields of two entries describing the same edge. Keys of the later entry
 * win on conflict; keys that only one entry has are all kept.
 */
function mergeExtra(current: JsonObject | null, incoming: JsonObject | null): JsonObject | null {
  if (incoming === null) return current;
  return { ...(current ?? {}), ...incoming };
}

function assertWithinLimit(what: string, count: number, max: number): void {
  if (count > max) {
    throw new PayloadTooLargeError(`The graph has more ${what} than allowed (maximum ${max}).`);
  }
}

function rejectDuplicateNames(nodes: FileNode[]): void {
  const firstSeen = new Map<string, number>();
  const duplicates: ErrorDetail[] = [];

  nodes.forEach((node, index) => {
    const first = firstSeen.get(node.name);
    if (first === undefined) {
      firstSeen.set(node.name, index);
    } else if (duplicates.length < MAX_REPORTED_DUPLICATES) {
      duplicates.push({
        path: `nodes.${index}.name`,
        message: `Duplicate node name "${node.name}" (first defined at nodes.${first})`,
      });
    }
  });

  if (duplicates.length > 0) {
    throw new ValidationError('Node names must be unique within a graph', duplicates, 'DUPLICATE_NODE_NAME');
  }
}

/**
 * Turns a validated file into what gets stored:
 *  - `to` (string or array) is split into one edge per target;
 *  - repeated edges are merged (their unknown fields are merged too); self-loops are kept;
 *  - the unknown fields of an edge entry are copied onto every edge it expands to;
 *  - names that edges reference but no node defines become placeholder nodes;
 *  - duplicate node names are rejected;
 *  - size limits are enforced.
 */
export function normalizeGraph(file: GraphFile, limits: GraphLimits): NormalizedGraph {
  assertWithinLimit('nodes', file.nodes.length, limits.maxNodes);
  rejectDuplicateNames(file.nodes);

  const defined = new Set(file.nodes.map((node) => node.name));
  const referenced = new Set<string>(); // insertion order = first reference
  const edges = new Map<string, EdgeRecord>();

  for (const entry of file.edges) {
    referenced.add(entry.from);
    for (const to of Array.isArray(entry.to) ? entry.to : [entry.to]) {
      referenced.add(to);
      // "\u0000" cannot appear in a JSON-decoded name that PostgreSQL would accept, so keys cannot collide.
      const key = `${entry.from}\u0000${to}`;
      const existing = edges.get(key);
      if (existing) {
        existing.extra = mergeExtra(existing.extra, entry.extra);
      } else {
        // Each edge gets its own copy, so edges expanded from one entry never share an object.
        edges.set(key, { from: entry.from, to, extra: mergeExtra(null, entry.extra) });
        // Stop early instead of expanding a huge fan-out first.
        assertWithinLimit('edges', edges.size, limits.maxEdges);
      }
    }
  }

  const placeholders = [...referenced].filter((name) => !defined.has(name));
  assertWithinLimit('nodes', file.nodes.length + placeholders.length, limits.maxNodes);

  return {
    extra: file.extra,
    nodes: [...file.nodes.map(toNodeRecord), ...placeholders.map(toPlaceholder)],
    edges: [...edges.values()],
    placeholders,
  };
}
