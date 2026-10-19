import type { NewFilter } from './filter.types';

/**
 * Filters every graph gets on creation, written as data in the rule language (see the filter
 * engine). They are read-only: the API refuses to edit or delete them.
 */
export const BUILTIN_FILTERS: readonly NewFilter[] = [
  {
    key: 'public',
    description: 'Services that are publicly exposed (publicExposed is true).',
    definition: { field: 'publicExposed', op: 'eq', value: true },
    isBuiltin: true,
  },
  {
    key: 'sink',
    description: 'Database sinks: nodes whose kind is rds or sql.',
    definition: { field: 'kind', op: 'in', value: ['rds', 'sql'] },
    isBuiltin: true,
  },
  {
    key: 'vulnerable',
    description: 'Nodes that have at least one vulnerability.',
    definition: { field: 'vulnerabilities', op: 'some' },
    isBuiltin: true,
  },
];

export const BUILTIN_FILTER_KEYS: readonly string[] = BUILTIN_FILTERS.map((filter) => filter.key);
