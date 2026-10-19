import type { JsonValue } from '../../shared/json';

/** Version of the rule format stored in `definition`; bump it when the rule language changes shape. */
export const CURRENT_DEFINITION_VERSION = 1;

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
