import { toRouteQuery, toRouteRoles } from '../../../../src/modules/queries/query.parser';
import { MAX_FILTERS_PER_ROLE, RouteQueryParamsSchema } from '../../../../src/modules/queries/query.schemas';

describe('RouteQueryParamsSchema', () => {
  const parse = (query: unknown) => RouteQueryParamsSchema.safeParse(query);
  const problems = (query: unknown) => {
    const result = parse(query);
    return result.success ? [] : result.error.issues.map((i) => i.path.join('.') || i.message);
  };

  it('accepts no parameters at all', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts one filter or a list of filters per role', () => {
    expect(parse({ start: 'public', end: ['sink', 'my-filter'], through: 'vulnerable' }).success).toBe(true);
  });

  it('rejects a parameter it does not know (a typo must not return the whole graph)', () => {
    expect(problems({ strat: 'public' })).toEqual(['Unrecognized key: "strat"']);
    expect(problems({ start: 'public', filter: 'x' })).toHaveLength(1);
  });

  it.each(['', 'Public', 'has space', '1abc', 'trailing-', 'a_b', 'x'.repeat(64)])('rejects the filter key %p', (key) => {
    expect(problems({ start: key })).not.toEqual([]);
    expect(problems({ end: [key] })).not.toEqual([]);
  });

  it('rejects a value that is not a string', () => {
    expect(problems({ start: { a: 'b' } })).not.toEqual([]);
    expect(problems({ start: [['a']] })).not.toEqual([]);
    expect(problems({ start: 5 })).not.toEqual([]);
  });

  it('rejects an empty list and a list over the limit', () => {
    expect(problems({ start: [] })).not.toEqual([]);
    expect(parse({ start: Array.from({ length: MAX_FILTERS_PER_ROLE }, (_, i) => `f${i}`) }).success).toBe(true);
    expect(problems({ start: Array.from({ length: MAX_FILTERS_PER_ROLE + 1 }, (_, i) => `f${i}`) })).not.toEqual([]);
  });
});

describe('toRouteRoles', () => {
  it('turns a single value and a list into lists, and a missing role into an empty list', () => {
    expect(toRouteRoles({ start: 'public', end: ['a', 'b'] })).toEqual({ start: ['public'], end: ['a', 'b'], through: [] });
  });

  it('removes repeats and keeps the order given', () => {
    expect(toRouteRoles({ start: ['b', 'a', 'b', 'a', 'c'] }).start).toEqual(['b', 'a', 'c']);
  });
});

describe('toRouteQuery', () => {
  it('leaves a role out when no filter was given for it', () => {
    expect(toRouteQuery({ start: [], end: [], through: [] })).toEqual({ start: undefined, end: undefined, through: undefined });
  });

  it('uses a plain filter condition for one filter', () => {
    expect(toRouteQuery({ start: ['public'], end: [], through: [] }).start).toEqual({ filter: 'public' });
  });

  it('joins several filters of one role with OR', () => {
    expect(toRouteQuery({ start: [], end: ['a', 'b'], through: [] }).end).toEqual({ or: [{ filter: 'a' }, { filter: 'b' }] });
  });
});
