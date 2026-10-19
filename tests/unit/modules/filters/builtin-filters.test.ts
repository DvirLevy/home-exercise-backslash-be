import { BUILTIN_FILTER_KEYS, BUILTIN_FILTERS } from '../../../../src/modules/filters/builtin-filters';

describe('BUILTIN_FILTERS', () => {
  it('defines exactly public, sink and vulnerable', () => {
    expect(BUILTIN_FILTER_KEYS).toEqual(['public', 'sink', 'vulnerable']);
  });

  it('marks all of them built-in, with a description', () => {
    for (const filter of BUILTIN_FILTERS) {
      expect(filter.isBuiltin).toBe(true);
      expect(filter.description).toBeTruthy();
    }
  });

  it('matches the agreed rules: only true is public, only rds and sql are sinks (not sqs)', () => {
    const rules = Object.fromEntries(BUILTIN_FILTERS.map((f) => [f.key, f.definition]));

    expect(rules.public).toEqual({ field: 'publicExposed', op: 'eq', value: true });
    expect(rules.sink).toEqual({ field: 'kind', op: 'in', value: ['rds', 'sql'] });
    expect(rules.vulnerable).toEqual({ field: 'vulnerabilities', op: 'some' });
  });

  it('uses keys the database accepts', () => {
    for (const key of BUILTIN_FILTER_KEYS) {
      expect(key).toMatch(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/);
    }
  });
});
