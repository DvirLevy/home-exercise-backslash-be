import type { JsonObject, JsonValue } from '../../../shared/json';

/**
 * The filter rule language. A filter is stored as data (a JSON rule tree) and compiled to a
 * predicate over nodes. A rule is exactly one of:
 *
 *   { "all": [Rule, ...] }                      every rule matches
 *   { "any": [Rule, ...] }                      at least one rule matches
 *   { "not": Rule }                             the rule does not match
 *   { "field": "kind", "op": "in", "value": ["rds", "sql"] }          a check on one field
 *   { "field": "vulnerabilities", "op": "some", "where": Rule }       some vulnerability matches
 */

export type RulePrimitive = string | number | boolean | null;

export type ComparisonOperator = 'eq' | 'neq';
export type ListOperator = 'in' | 'notIn';
export type ExistenceOperator = 'exists' | 'notExists';
export type NumericOperator = 'gt' | 'gte' | 'lt' | 'lte';

export type FieldRule =
  | { field: string; op: ComparisonOperator; value: RulePrimitive }
  | { field: string; op: ListOperator; value: RulePrimitive[] }
  | { field: string; op: ExistenceOperator }
  | { field: string; op: 'contains'; value: string }
  | { field: string; op: NumericOperator; value: number }
  | { field: 'vulnerabilities'; op: 'some'; where?: Rule };

export type Rule = { all: Rule[] } | { any: Rule[] } | { not: Rule } | FieldRule;

export type FieldOperator = Exclude<FieldRule['op'], 'some'> | 'some';

export const OPERATORS = [
  'eq',
  'neq',
  'in',
  'notIn',
  'exists',
  'notExists',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'some',
] as const satisfies readonly FieldOperator[];

/** Bounds that keep a stored rule cheap to validate, compile and run. */
export const RULE_LIMITS = {
  /** Nesting of rules, the root being depth 1. */
  maxDepth: 8,
  /** Rule objects in the whole tree. */
  maxRules: 100,
  /** Entries of one `all` / `any` list. */
  maxChildren: 50,
  /** Entries of one `in` / `notIn` list. */
  maxListValues: 1_000,
  maxStringLength: 1_000,
  /** Dotted segments of a field path, e.g. `metadata.a.b` has 3. */
  maxPathSegments: 6,
  maxSegmentLength: 64,
} as const;

/** Fields of a node that hold a single value. */
export const NODE_SCALAR_FIELDS = ['name', 'kind', 'language', 'path', 'publicExposed'] as const;
/** Fields of a node that hold an object addressed by a dotted path, e.g. `metadata.engine`. */
export const NODE_OBJECT_FIELDS = ['metadata', 'extra'] as const;

/** What a rule can look at: the stored node, without the bookkeeping fields. */
export interface FilterableNode {
  name: string;
  kind: string | null;
  language: string | null;
  path: string | null;
  publicExposed: boolean | null;
  vulnerabilities: JsonValue[];
  metadata: JsonObject | null;
  extra: JsonObject | null;
}
