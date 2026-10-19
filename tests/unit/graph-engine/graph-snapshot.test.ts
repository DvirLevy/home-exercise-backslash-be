import { buildSnapshot, GraphIntegrityError } from '../../../src/graph-engine/graph-snapshot';
import type { EngineNode } from '../../../src/graph-engine/types';
import { snap, sorted } from '../../helpers/engine';

describe('buildSnapshot', () => {
  describe('adjacency lists', () => {
    const snapshot = snap({
      nodes: ['a', 'b', 'c', 'd'],
      edges: [['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'a']],
    });

    it('keeps the forward direction', () => {
      expect(sorted(snapshot.successors('a'))).toEqual(['b', 'c']);
      expect(sorted(snapshot.successors('b'))).toEqual(['c']);
      expect(sorted(snapshot.successors('c'))).toEqual(['a']);
    });

    it('keeps the reverse direction', () => {
      expect(sorted(snapshot.predecessors('a'))).toEqual(['c']);
      expect(sorted(snapshot.predecessors('b'))).toEqual(['a']);
      expect(sorted(snapshot.predecessors('c'))).toEqual(['a', 'b']);
    });

    it('has empty lists for a node without edges, and for a name it does not know', () => {
      expect([...snapshot.successors('d')]).toEqual([]);
      expect([...snapshot.predecessors('d')]).toEqual([]);
      expect([...snapshot.successors('nope')]).toEqual([]);
      expect([...snapshot.outgoingEdges('nope')]).toEqual([]);
    });

    it('only stores entries for nodes that have edges', () => {
      expect([...snapshot.outgoing.keys()].sort()).toEqual(['a', 'b', 'c']);
      expect([...snapshot.incoming.keys()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('lists a self-loop in both directions', () => {
      const looped = snap({ nodes: ['a', 'b'], edges: [['a', 'a'], ['a', 'b']] });

      expect(sorted(looped.successors('a'))).toEqual(['a', 'b']);
      expect(sorted(looped.predecessors('a'))).toEqual(['a']);
    });

    it('ignores a repeated edge', () => {
      const repeated = snap({ nodes: ['a', 'b'], edges: [['a', 'b'], ['a', 'b'], ['a', 'b']] });

      expect(repeated.edgeCount).toBe(1);
      expect([...repeated.outgoingEdges('a')]).toHaveLength(1);
    });

    it('treats the reverse direction as a different edge', () => {
      const both = snap({ nodes: ['a', 'b'], edges: [['a', 'b'], ['b', 'a']] });

      expect(both.edgeCount).toBe(2);
    });

    it('hands back the edge objects it was given, with whatever they carry', () => {
      const edge = { from: 'a', to: 'b', extra: { weight: 3 } };

      const withData = buildSnapshot({
        id: 'g',
        version: 1,
        nodes: [{ name: 'a', isPlaceholder: false }, { name: 'b', isPlaceholder: false }],
        edges: [edge],
      });

      expect([...withData.outgoingEdges('a')][0]).toBe(edge);
    });
  });

  describe('nodes', () => {
    it('keeps the order of the file and exposes the id, version and counts', () => {
      const snapshot = snap({ id: 'graph-1', version: 7, nodes: ['z', 'a', 'm'], placeholders: ['ghost'], edges: [['z', 'a']] });

      expect([...snapshot.nodes.keys()]).toEqual(['z', 'a', 'm', 'ghost']);
      expect(snapshot.graphId).toBe('graph-1');
      expect(snapshot.version).toBe(7);
      expect(snapshot.edgeCount).toBe(1);
    });

    it('lists the real (non-placeholder) node names', () => {
      const snapshot = snap({ nodes: ['a', 'b'], placeholders: ['ghost'], edges: [] });

      expect(sorted(snapshot.realNodeNames())).toEqual(['a', 'b']);
    });

    it('builds an empty snapshot', () => {
      const empty = snap({ nodes: [], edges: [] });

      expect(empty.nodes.size).toBe(0);
      expect(empty.edgeCount).toBe(0);
      expect(empty.realNodeNames().size).toBe(0);
    });
  });

  describe('filter index', () => {
    it('holds, per filter, the names of the nodes it matches', () => {
      const snapshot = snap({
        nodes: ['a', 'b', 'c'],
        edges: [],
        filters: { first: ['a', 'b'], second: ['c'], none: [] },
      });

      expect(sorted(snapshot.filterIndex.get('first')!)).toEqual(['a', 'b']);
      expect(sorted(snapshot.filterIndex.get('second')!)).toEqual(['c']);
      expect(snapshot.filterIndex.get('none')!.size).toBe(0);
      expect(snapshot.filterIndex.has('unknown')).toBe(false);
    });

    it('never lets a placeholder match, whatever the predicate says', () => {
      const nodes: EngineNode[] = [
        { name: 'real', isPlaceholder: false },
        { name: 'ghost', isPlaceholder: true },
      ];

      const snapshot = buildSnapshot({ id: 'g', version: 1, nodes, edges: [] }, new Map([['everything', () => true]]));

      expect(sorted(snapshot.filterIndex.get('everything')!)).toEqual(['real']);
    });

    it('evaluates each predicate once per real node, at build time only', () => {
      const predicate = jest.fn((node: EngineNode) => node.name === 'a');

      const snapshot = buildSnapshot(
        {
          id: 'g',
          version: 1,
          nodes: [{ name: 'a', isPlaceholder: false }, { name: 'b', isPlaceholder: false }, { name: 'ghost', isPlaceholder: true }],
          edges: [],
        },
        new Map([['f', predicate]]),
      );
      snapshot.filterIndex.get('f');

      expect(predicate).toHaveBeenCalledTimes(2);
    });

    it('is empty when no filters are given', () => {
      expect(snap({ nodes: ['a'], edges: [] }).filterIndex.size).toBe(0);
    });
  });

  describe('integrity', () => {
    const nodes = [{ name: 'a', isPlaceholder: false }, { name: 'b', isPlaceholder: false }];

    it('refuses an edge to an unknown node', () => {
      expect(() => buildSnapshot({ id: 'g', version: 1, nodes, edges: [{ from: 'a', to: 'zzz' }] })).toThrow(GraphIntegrityError);
      expect(() => buildSnapshot({ id: 'g', version: 1, nodes, edges: [{ from: 'zzz', to: 'a' }] })).toThrow(/unknown node/);
    });

    it('refuses two nodes with the same name', () => {
      expect(() =>
        buildSnapshot({ id: 'g', version: 1, nodes: [...nodes, { name: 'a', isPlaceholder: false }], edges: [] }),
      ).toThrow(/two nodes named "a"/);
    });
  });
});
