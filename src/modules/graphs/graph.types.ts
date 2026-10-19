import type { JsonObject, JsonValue } from '../../shared/json';

/** A node as stored. Placeholders (referenced but never defined) carry only a name. */
export interface NodeRecord {
  name: string;
  kind: string | null;
  language: string | null;
  path: string | null;
  /** `null` when the file did not say; only `true` counts as publicly exposed. */
  publicExposed: boolean | null;
  isPlaceholder: boolean;
  vulnerabilities: JsonValue[];
  metadata: JsonObject | null;
  /** Unknown fields from the uploaded file, kept as-is. */
  extra: JsonObject | null;
}

export interface EdgeRecord {
  from: string;
  to: string;
}

export interface GraphData {
  nodes: NodeRecord[];
  edges: EdgeRecord[];
}

export interface NewGraph extends GraphData {
  name: string;
}

export interface GraphSummary {
  id: string;
  name: string;
  version: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A graph with its content, read from one consistent snapshot. */
export interface StoredGraph extends GraphData {
  id: string;
  name: string;
  version: number;
}
