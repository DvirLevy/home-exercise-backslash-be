import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../../shared/json';

/**
 * The uploaded graph file is validated against what the sample file defines (types of the known
 * fields), and every field the schema does not know is preserved, at every level:
 *   - top level  -> `GraphFile.extra`
 *   - each node  -> `FileNode.extra`
 *   - each edge entry -> `FileEdge.extra`
 *   - vulnerabilities and `metadata` objects are kept whole, unknown fields included.
 *
 * The Zod schemas below only VALIDATE (their parsed output is discarded). Preserved data is read
 * from the validated raw JSON, because Zod's output silently drops keys such as "__proto__".
 */

const VulnerabilitySchema = z.looseObject({
  file: z.string().optional(),
  severity: z.string().optional(), // free-form: the file does not define the set of severities
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const NodeSchema = z.looseObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  language: z.string().nullish(),
  path: z.string().nullish(),
  publicExposed: z.boolean().nullish(),
  vulnerabilities: z.array(VulnerabilitySchema).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const EdgeTargetSchema = z.string().min(1);

const EdgeSchema = z.looseObject({
  from: z.string().min(1),
  // The sample uses a single string once and arrays everywhere else.
  to: z.union([EdgeTargetSchema, z.array(EdgeTargetSchema)], { error: 'must be a string or an array of strings' }),
});

export const GraphFileSchema = z.looseObject({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

const KNOWN_NODE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'kind',
  'language',
  'path',
  'publicExposed',
  'vulnerabilities',
  'metadata',
]);
const KNOWN_EDGE_FIELDS: ReadonlySet<string> = new Set(['from', 'to']);
const KNOWN_FILE_FIELDS: ReadonlySet<string> = new Set(['nodes', 'edges']);

/** A node as read from the file: known fields typed, everything else collected under `extra`. */
export interface FileNode {
  name: string;
  kind: string;
  language: string | null;
  path: string | null;
  publicExposed: boolean | null;
  vulnerabilities: JsonValue[];
  metadata: JsonObject | null;
  extra: JsonObject | null;
}

/** One edge entry of the file; `to` is still a string or a list (the normalizer splits it). */
export interface FileEdge {
  from: string;
  to: string | string[];
  extra: JsonObject | null;
}

export interface GraphFile {
  nodes: FileNode[];
  edges: FileEdge[];
  extra: JsonObject | null;
}

type RawObject = Record<string, unknown>;

/** Own enumerable keys that are not in `known`, in file order; null when there are none. */
function collectExtra(raw: RawObject, known: ReadonlySet<string>): JsonObject | null {
  const extra: JsonObject = {};
  let found = false;
  for (const key of Object.keys(raw)) {
    if (known.has(key)) continue;
    // defineProperty (not assignment) so that a key named "__proto__" stays an ordinary own key.
    Object.defineProperty(extra, key, { value: raw[key], enumerable: true, writable: true, configurable: true });
    found = true;
  }
  return found ? extra : null;
}

function readNode(raw: RawObject): FileNode {
  return {
    name: raw.name as string,
    kind: raw.kind as string,
    language: (raw.language ?? null) as string | null,
    path: (raw.path ?? null) as string | null,
    publicExposed: (raw.publicExposed ?? null) as boolean | null,
    vulnerabilities: (raw.vulnerabilities ?? []) as JsonValue[],
    metadata: (raw.metadata ?? null) as JsonObject | null,
    extra: collectExtra(raw, KNOWN_NODE_FIELDS),
  };
}

function readEdge(raw: RawObject): FileEdge {
  return {
    from: raw.from as string,
    to: raw.to as string | string[],
    extra: collectExtra(raw, KNOWN_EDGE_FIELDS),
  };
}

/**
 * Validates the parsed JSON of an uploaded file and returns it as a GraphFile.
 * Throws a ZodError (-> 400 with the exact field paths) when the content does not fit.
 */
export function parseGraphFile(content: unknown): GraphFile {
  GraphFileSchema.parse(content);

  // Validated above: an object whose `nodes` and `edges` are arrays of objects.
  const raw = content as { nodes: RawObject[]; edges: RawObject[] } & RawObject;
  return {
    nodes: raw.nodes.map(readNode),
    edges: raw.edges.map(readEdge),
    extra: collectExtra(raw, KNOWN_FILE_FIELDS),
  };
}
