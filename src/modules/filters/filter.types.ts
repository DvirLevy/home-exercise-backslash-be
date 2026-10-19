import type { JsonValue } from '../../shared/json';

/** Version of the rule format stored in `definition`; bump it when the rule language changes shape. */
export const CURRENT_DEFINITION_VERSION = 1;

/**
 * A filter key is used in URLs (`?start=public`) and in the database CHECK constraint
 * `graph_filters_key_format_check`: keep this pattern identical to that constraint.
 */
export const FILTER_KEY_PATTERN = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Built-in and custom filters together; each one keeps an index of matching nodes in memory. */
export const MAX_FILTERS_PER_GRAPH = 100;

export interface FilterRecord {
  id: string;
  graphId: string;
  key: string;
  description: string | null;
  definition: JsonValue;
  definitionVersion: number;
  isBuiltin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFilter {
  key: string;
  description: string | null;
  definition: JsonValue;
  isBuiltin: boolean;
}

export interface FilterChanges {
  description: string | null;
  definition: JsonValue;
}
