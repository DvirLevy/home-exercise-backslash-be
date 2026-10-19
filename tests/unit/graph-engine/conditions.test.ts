import {
  collectFilterKeys,
  MAX_CONDITION_DEPTH,
  resolveCondition,
  UnknownFilterError,
  type Condition,
} from '../../../src/graph-engine/conditions';
import { snap, sorted } from '../../helpers/engine';

const snapshot = snap({
  nodes: ['a', 'b', 'c', 'd', 'e'],
  placeholders: ['ghost'],
  edges: [],
  filters: { odd: ['a', 'c', 'e'], low: ['a', 'b', 'c'], vowel: ['a', 'e'], none: [] },
});
const resolve = (condition: Condition) => sorted(resolveCondition(snapshot, condition));

describe('resolveCondition', () => {
  it('resolves a filter to the nodes matching it', () => {
    expect(resolve({ filter: 'odd' })).toEqual(['a', 'c', 'e']);
    expect(resolve({ filter: 'none' })).toEqual([]);
  });

  it('joins filters of one role with OR', () => {
    expect(resolve({ or: [{ filter: 'vowel' }, { filter: 'low' }] })).toEqual(['a', 'b', 'c', 'e']);
  });

  it('joins with AND by intersecting', () => {
    expect(resolve({ and: [{ filter: 'odd' }, { filter: 'low' }] })).toEqual(['a', 'c']);
    expect(resolve({ and: [{ filter: 'odd' }, { filter: 'low' }, { filter: 'vowel' }] })).toEqual(['a']);
    expect(resolve({ and: [{ filter: 'odd' }, { filter: 'none' }] })).toEqual([]);
  });

  it('negates against the real nodes only: a placeholder is never produced', () => {
    expect(resolve({ not: { filter: 'odd' } })).toEqual(['b', 'd']);
    expect(resolve({ not: { filter: 'none' } })).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('nests freely', () => {
    expect(resolve({ and: [{ or: [{ filter: 'vowel' }, { filter: 'low' }] }, { not: { filter: 'odd' } }] })).toEqual(['b']);
  });

  it('gives an empty OR nothing and an empty AND every real node', () => {
    expect(resolve({ or: [] })).toEqual([]);
    expect(resolve({ and: [] })).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not change the index it reads from', () => {
    resolve({ or: [{ filter: 'vowel' }, { filter: 'low' }] });
    resolve({ and: [{ filter: 'odd' }, { filter: 'low' }] });

    expect(sorted(snapshot.filterIndex.get('vowel')!)).toEqual(['a', 'e']);
    expect(sorted(snapshot.filterIndex.get('low')!)).toEqual(['a', 'b', 'c']);
  });

  it('names the unknown filter it ran into, at any depth', () => {
    expect(() => resolve({ filter: 'missing' })).toThrow(UnknownFilterError);
    expect(() => resolve({ or: [{ filter: 'odd' }, { not: { filter: 'missing' } }] })).toThrow(
      expect.objectContaining({ key: 'missing', message: 'Unknown filter "missing"' }),
    );
  });

  it('refuses a tree deeper than the limit instead of overflowing the stack', () => {
    let condition: Condition = { filter: 'odd' };
    for (let i = 0; i < MAX_CONDITION_DEPTH + 5; i += 1) condition = { not: condition };

    expect(() => resolveCondition(snapshot, condition)).toThrow(RangeError);
  });
});

describe('collectFilterKeys', () => {
  it('lists each filter once, in order of first appearance', () => {
    const condition: Condition = {
      and: [{ or: [{ filter: 'b' }, { filter: 'a' }] }, { not: { filter: 'c' } }, { filter: 'a' }],
    };

    expect(collectFilterKeys(condition)).toEqual(['b', 'a', 'c']);
  });

  it('handles a single filter and an empty combinator', () => {
    expect(collectFilterKeys({ filter: 'x' })).toEqual(['x']);
    expect(collectFilterKeys({ or: [] })).toEqual([]);
  });
});
