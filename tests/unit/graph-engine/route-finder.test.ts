import { UnknownFilterError } from '../../../src/graph-engine/conditions';
import { buildSnapshot } from '../../../src/graph-engine/graph-snapshot';
import { findRoutes } from '../../../src/graph-engine/route-finder';
import { edgeNames, nodeNames, snap, sorted, type TestEdge, type TestNode } from '../../helpers/engine';

const start = { filter: 'start' };
const end = { filter: 'end' };
const through = { filter: 'through' };

describe('findRoutes', () => {
  describe('shapes', () => {
    it('follows a straight chain', () => {
      const snapshot = snap({ nodes: ['a', 'b', 'c', 'd'], edges: [['a', 'b'], ['b', 'c'], ['c', 'd']], filters: { start: ['a'], end: ['d'] } });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['a', 'b', 'c', 'd']);
      expect(edgeNames(result)).toEqual(['a>b', 'b>c', 'c>d']);
    });

    it('keeps both sides of a diamond', () => {
      const snapshot = snap({
        nodes: ['s', 'a', 'b', 't'],
        edges: [['s', 'a'], ['s', 'b'], ['a', 't'], ['b', 't']],
        filters: { start: ['s'], end: ['t'] },
      });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['s', 'a', 'b', 't']);
      expect(edgeNames(result)).toEqual(['a>t', 'b>t', 's>a', 's>b']);
    });

    it('handles several start and end nodes and drops everything that is not on a route', () => {
      const snapshot = snap({
        nodes: ['s1', 's2', 'x', 'm', 't1', 't2', 'dead'],
        edges: [['s1', 'm'], ['s2', 'm'], ['x', 'm'], ['m', 't1'], ['m', 't2'], ['m', 'dead']],
        filters: { start: ['s1', 's2'], end: ['t1', 't2'] },
      });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['s1', 's2', 'm', 't1', 't2']); // not x (nothing starts there), not dead (no end)
      expect(edgeNames(result)).toEqual(['m>t1', 'm>t2', 's1>m', 's2>m']);
    });

    it('leaves out disconnected nodes and a branch that never reaches an end', () => {
      const snapshot = snap({
        nodes: ['s', 't', 'island', 'branch'],
        edges: [['s', 't'], ['s', 'branch']],
        filters: { start: ['s'], end: ['t'] },
      });

      expect(nodeNames(findRoutes(snapshot, { start, end }))).toEqual(['s', 't']);
    });

    it('treats a node that is both a start and an end as a route of its own', () => {
      const snapshot = snap({ nodes: ['a', 'b'], edges: [], filters: { start: ['a', 'b'], end: ['a'] } });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['a']);
      expect(result.nodes[0]?.roles).toEqual(['start', 'end']);
    });

    it('with only a start, returns everything reachable from it', () => {
      const snapshot = snap({ nodes: ['s', 'a', 'b', 'other'], edges: [['s', 'a'], ['a', 'b'], ['other', 'a']], filters: { start: ['s'] } });

      const result = findRoutes(snapshot, { start });

      expect(nodeNames(result)).toEqual(['s', 'a', 'b']);
      expect(edgeNames(result)).toEqual(['a>b', 's>a']);
    });

    it('with only an end, returns everything that can reach it', () => {
      const snapshot = snap({ nodes: ['t', 'a', 'b', 'other'], edges: [['a', 't'], ['b', 'a'], ['t', 'other']], filters: { end: ['t'] } });

      const result = findRoutes(snapshot, { end });

      expect(nodeNames(result)).toEqual(['t', 'a', 'b']);
      expect(edgeNames(result)).toEqual(['a>t', 'b>a']);
    });
  });

  describe('cycles and self-loops', () => {
    it('terminates on a cycle and includes the whole cycle', () => {
      const snapshot = snap({
        nodes: ['s', 'a', 'b', 't'],
        edges: [['s', 'a'], ['a', 'b'], ['b', 'a'], ['b', 't']],
        filters: { start: ['s'], end: ['t'] },
      });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['s', 'a', 'b', 't']);
      expect(edgeNames(result)).toEqual(['a>b', 'b>a', 'b>t', 's>a']);
    });

    it('leaves out a cycle that cannot reach an end', () => {
      const snapshot = snap({
        nodes: ['s', 'a', 'b', 't'],
        edges: [['s', 'a'], ['a', 'b'], ['b', 'a'], ['s', 't']],
        filters: { start: ['s'], end: ['t'] },
      });

      expect(nodeNames(findRoutes(snapshot, { start, end }))).toEqual(['s', 't']);
    });

    it('keeps a self-loop on a node that is on a route', () => {
      const snapshot = snap({ nodes: ['s', 't'], edges: [['s', 's'], ['s', 't']], filters: { start: ['s'], end: ['t'] } });

      expect(edgeNames(findRoutes(snapshot, { start, end }))).toEqual(['s>s', 's>t']);
    });

    it('handles a graph that is one big cycle', () => {
      const snapshot = snap({ nodes: ['a', 'b', 'c'], edges: [['a', 'b'], ['b', 'c'], ['c', 'a']], filters: { start: ['a'], end: ['c'] } });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['a', 'b', 'c']);
      expect(edgeNames(result)).toEqual(['a>b', 'b>c', 'c>a']);
    });

    it('handles a long chain without recursion (100,000 nodes)', () => {
      const count = 100_000;
      const names = Array.from({ length: count }, (_, i) => `n${i}`);
      const edges = names.slice(1).map((name, i): [string, string] => [names[i]!, name]);
      const snapshot = snap({ nodes: names, edges, filters: { start: ['n0'], end: [`n${count - 1}`] } });

      const result = findRoutes(snapshot, { start, end });

      expect(result.nodes).toHaveLength(count);
      expect(result.edges).toHaveLength(count - 1);
    });
  });

  describe('through', () => {
    it('keeps a route that passes through the node, whether it comes before or after', () => {
      const chain = snap({ nodes: ['s', 'm', 't'], edges: [['s', 'm'], ['m', 't']], filters: { start: ['s'], end: ['t'], through: ['m'] } });

      const result = findRoutes(chain, { start, end, through });

      expect(nodeNames(result)).toEqual(['s', 'm', 't']);
      expect(edgeNames(result)).toEqual(['m>t', 's>m']);
    });

    it('drops a route that bypasses the through node (the key case)', () => {
      const snapshot = snap({
        nodes: ['s', 'a', 'm', 't'],
        edges: [['s', 'a'], ['a', 't'], ['s', 'm'], ['m', 't']],
        filters: { start: ['s'], end: ['t'], through: ['m'] },
      });

      const result = findRoutes(snapshot, { start, end, through });

      expect(nodeNames(result)).toEqual(['s', 'm', 't']); // not a
      expect(edgeNames(result)).toEqual(['m>t', 's>m']); // not s>a, not a>t
    });

    it('counts a start node that matches the through filter', () => {
      const snapshot = snap({ nodes: ['s', 't'], edges: [['s', 't']], filters: { start: ['s'], end: ['t'], through: ['s'] } });

      const result = findRoutes(snapshot, { start, end, through });

      expect(nodeNames(result)).toEqual(['s', 't']);
      expect(result.nodes[0]?.roles).toEqual(['start', 'through']);
    });

    it('counts an end node that matches the through filter', () => {
      const snapshot = snap({ nodes: ['s', 't'], edges: [['s', 't']], filters: { start: ['s'], end: ['t'], through: ['t'] } });

      const result = findRoutes(snapshot, { start, end, through });

      expect(nodeNames(result)).toEqual(['s', 't']);
      expect(result.nodes[1]?.roles).toEqual(['through', 'end']);
    });

    it('finds nothing when the through node is unreachable from the start', () => {
      const snapshot = snap({ nodes: ['s', 't', 'm'], edges: [['s', 't']], filters: { start: ['s'], end: ['t'], through: ['m'] } });

      expect(findRoutes(snapshot, { start, end, through }).nodes).toEqual([]);
    });

    it('finds nothing when the through node is reachable but leads away from the end', () => {
      const snapshot = snap({
        nodes: ['s', 'm', 't'],
        edges: [['s', 'm'], ['s', 't']],
        filters: { start: ['s'], end: ['t'], through: ['m'] },
      });

      expect(findRoutes(snapshot, { start, end, through }).nodes).toEqual([]);
    });

    it('accepts a route that goes round a cycle to reach the through node and come back', () => {
      // s -> a -> t is the direct way, but only s -> a -> b -> a -> t passes through b.
      const snapshot = snap({
        nodes: ['s', 'a', 'b', 't'],
        edges: [['s', 'a'], ['a', 'b'], ['b', 'a'], ['a', 't']],
        filters: { start: ['s'], end: ['t'], through: ['b'] },
      });

      const result = findRoutes(snapshot, { start, end, through });

      expect(nodeNames(result)).toEqual(['s', 'a', 'b', 't']);
      expect(edgeNames(result)).toEqual(['a>b', 'a>t', 'b>a', 's>a']);
    });

    it('accepts any one of several through nodes', () => {
      const snapshot = snap({
        nodes: ['s', 'm1', 'm2', 'plain', 't'],
        edges: [['s', 'm1'], ['s', 'm2'], ['s', 'plain'], ['m1', 't'], ['m2', 't'], ['plain', 't']],
        filters: { start: ['s'], end: ['t'], through: ['m1', 'm2'] },
      });

      expect(nodeNames(findRoutes(snapshot, { start, end, through }))).toEqual(['s', 'm1', 'm2', 't']);
    });

    it('with only a through filter, returns the nodes that can lead to it or come from it', () => {
      const snapshot = snap({
        nodes: ['x', 'm', 'y', 'u', 'v'],
        edges: [['x', 'm'], ['m', 'y'], ['u', 'v']],
        filters: { through: ['m'] },
      });

      const result = findRoutes(snapshot, { through });

      expect(nodeNames(result)).toEqual(['x', 'm', 'y']);
      expect(edgeNames(result)).toEqual(['m>y', 'x>m']);
    });

    it('with a start and a through filter, ignores branches that skip the through node', () => {
      const snapshot = snap({
        nodes: ['s', 'm', 'y', 'z'],
        edges: [['s', 'm'], ['m', 'y'], ['s', 'z']],
        filters: { start: ['s'], through: ['m'] },
      });

      expect(nodeNames(findRoutes(snapshot, { start, through }))).toEqual(['s', 'm', 'y']);
    });

    it('with an end and a through filter, ignores branches that skip the through node', () => {
      const snapshot = snap({
        nodes: ['a', 'm', 't', 'z'],
        edges: [['a', 'm'], ['m', 't'], ['z', 't']],
        filters: { end: ['t'], through: ['m'] },
      });

      expect(nodeNames(findRoutes(snapshot, { end, through }))).toEqual(['a', 'm', 't']);
    });
  });

  describe('nothing to find', () => {
    it('returns an empty result when a role matches no node', () => {
      const snapshot = snap({ nodes: ['a', 'b'], edges: [['a', 'b']], filters: { start: ['a'], end: ['b'], through: ['a'], none: [] } });

      for (const query of [{ start: { filter: 'none' }, end }, { start, end: { filter: 'none' } }, { start, end, through: { filter: 'none' } }, { through: { filter: 'none' } }]) {
        expect(findRoutes(snapshot, query)).toEqual({ nodes: [], edges: [] });
      }
    });

    it('returns an empty result when no route exists between the start and the end', () => {
      const snapshot = snap({ nodes: ['a', 'b'], edges: [['b', 'a']], filters: { start: ['a'], end: ['b'] } });

      expect(findRoutes(snapshot, { start, end })).toEqual({ nodes: [], edges: [] });
    });

    it('returns an empty result for an empty graph', () => {
      const snapshot = snap({ nodes: [], edges: [], filters: { start: [], end: [] } });

      expect(findRoutes(snapshot, { start, end })).toEqual({ nodes: [], edges: [] });
    });
  });

  describe('no constraint at all', () => {
    it('returns the whole graph: isolated nodes, placeholders and every edge', () => {
      const snapshot = snap({
        nodes: ['a', 'b', 'lonely'],
        placeholders: ['ghost'],
        edges: [['a', 'b'], ['b', 'ghost'], ['a', 'a']],
      });

      const result = findRoutes(snapshot, {});

      expect(nodeNames(result)).toEqual(['a', 'b', 'lonely', 'ghost']);
      expect(edgeNames(result)).toEqual(['a>a', 'a>b', 'b>ghost']);
      expect(result.nodes.every((n) => n.roles.length === 0 && n.filters.length === 0)).toBe(true);
    });
  });

  describe('combining filters', () => {
    const snapshot = snap({
      nodes: ['s1', 's2', 's3', 't'],
      edges: [['s1', 't'], ['s2', 't'], ['s3', 't']],
      filters: { a: ['s1', 's2'], b: ['s2', 's3'], end: ['t'] },
    });

    it('joins the filters of one role with OR', () => {
      const result = findRoutes(snapshot, { start: { or: [{ filter: 'a' }, { filter: 'b' }] }, end });

      expect(nodeNames(result)).toEqual(['s1', 's2', 's3', 't']);
    });

    it('joins with AND by intersecting', () => {
      const result = findRoutes(snapshot, { start: { and: [{ filter: 'a' }, { filter: 'b' }] }, end });

      expect(nodeNames(result)).toEqual(['s2', 't']);
    });

    it('supports negation', () => {
      const result = findRoutes(snapshot, { start: { not: { filter: 'a' } }, end });

      expect(nodeNames(result)).toEqual(['s3', 't']);
    });

    it('requires every role to hold at once (AND across roles)', () => {
      const graph = snap({
        nodes: ['s', 'x', 'y', 't'],
        edges: [['s', 'x'], ['s', 'y'], ['x', 't'], ['y', 't']],
        filters: { start: ['s'], end: ['t'], via: ['x'] },
      });

      expect(nodeNames(findRoutes(graph, { start, end }))).toEqual(['s', 'x', 'y', 't']);
      expect(nodeNames(findRoutes(graph, { start, end, through: { filter: 'via' } }))).toEqual(['s', 'x', 't']);
    });

    it('rejects an unknown filter anywhere in the query', () => {
      expect(() => findRoutes(snapshot, { start: { filter: 'nope' } })).toThrow(UnknownFilterError);
      expect(() => findRoutes(snapshot, { start, end: { or: [{ filter: 'nope' }] } })).toThrow(UnknownFilterError);
    });
  });

  describe('placeholders', () => {
    it('can be in the middle of a route but never plays a role or matches a filter', () => {
      const snapshot = snap({
        nodes: ['s', 't'],
        placeholders: ['ghost'],
        edges: [['s', 'ghost'], ['ghost', 't']],
        filters: { start: ['s'], end: ['t'], everything: ['s', 't', 'ghost'] },
      });

      const result = findRoutes(snapshot, { start, end });

      expect(nodeNames(result)).toEqual(['s', 't', 'ghost']); // placeholders are listed after the real nodes
      expect(result.nodes[2]?.roles).toEqual([]);
      expect(result.nodes[2]?.filters).toEqual([]);
    });

    it('is not a start or end even when a predicate would match it', () => {
      const nodes: TestNode[] = [{ name: 'real', isPlaceholder: false }, { name: 'ghost', isPlaceholder: true }];
      const snapshot = buildSnapshot({ id: 'g', version: 1, nodes, edges: [{ from: 'real', to: 'ghost' }] }, new Map([['all', () => true]]));

      const result = findRoutes(snapshot, { end: { filter: 'all' } });

      expect(nodeNames(result)).toEqual(['real']);
    });

    it('is not produced by a negation', () => {
      const snapshot = snap({ nodes: ['a'], placeholders: ['ghost'], edges: [['a', 'ghost']], filters: { f: ['a'] } });

      const result = findRoutes(snapshot, { start: { not: { filter: 'f' } } });

      expect(result.nodes).toEqual([]);
    });
  });

  describe('what is reported about each node', () => {
    const snapshot = snap({
      nodes: ['s', 'm', 't', 'side'],
      edges: [['s', 'm'], ['m', 't'], ['s', 'side']],
      filters: { entry: ['s'], sink: ['t'], risky: ['m', 'side'], unused: ['side'] },
    });
    const query = { start: { filter: 'entry' }, end: { filter: 'sink' }, through: { filter: 'risky' } };

    it('tags the roles a node really plays', () => {
      const result = findRoutes(snapshot, query);

      expect(result.nodes.map((n) => [n.node.name, n.roles])).toEqual([
        ['s', ['start']],
        ['m', ['through']],
        ['t', ['end']],
      ]);
    });

    it('tags the filters of the query that the node matches, and no others', () => {
      const result = findRoutes(snapshot, query);

      expect(result.nodes.map((n) => [n.node.name, n.filters])).toEqual([
        ['s', ['entry']],
        ['m', ['risky']],
        ['t', ['sink']],
      ]);
    });

    it('only calls a node a start if a route can really begin there', () => {
      // b is a start node too, but the only through node lies on a's branch.
      const graph = snap({
        nodes: ['a', 'b', 'm', 't'],
        edges: [['a', 'm'], ['m', 't'], ['b', 't']],
        filters: { start: ['a', 'b'], end: ['t'], through: ['m'] },
      });

      const result = findRoutes(graph, { start, end, through });

      expect(nodeNames(result)).toEqual(['a', 'm', 't']);
    });

    it('returns nodes in the order of the file, edges grouped by their source node', () => {
      const graph = snap({ nodes: ['z', 'a', 'm'], edges: [['m', 'a'], ['z', 'm'], ['a', 'z']], filters: { all: ['z', 'a', 'm'] } });

      const result = findRoutes(graph, { start: { filter: 'all' } });

      expect(nodeNames(result)).toEqual(['z', 'a', 'm']);
      expect(result.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['z>m', 'a>z', 'm>a']);
    });

    it('returns the very edge objects of the snapshot, with whatever they carry', () => {
      const withData = { from: 's', to: 't', extra: { weight: 9 } };
      const nodes: TestNode[] = [{ name: 's', isPlaceholder: false }, { name: 't', isPlaceholder: false }];
      const graph = buildSnapshot<TestNode, TestEdge>(
        { id: 'g', version: 1, nodes, edges: [withData] },
        new Map([['s', (n: TestNode) => n.name === 's']]),
      );

      const result = findRoutes(graph, { start: { filter: 's' } });

      expect(result.edges[0]).toBe(withData);
    });
  });

  describe('purity', () => {
    it('does not change the snapshot, so repeated queries give the same answer', () => {
      const snapshot = snap({
        nodes: ['s', 'a', 'm', 't'],
        edges: [['s', 'a'], ['a', 't'], ['s', 'm'], ['m', 't']],
        filters: { start: ['s'], end: ['t'], through: ['m'] },
      });
      const before = { edges: snapshot.edgeCount, nodes: sorted(snapshot.nodes.keys()), index: sorted(snapshot.filterIndex.get('start')!) };

      const first = findRoutes(snapshot, { start, end, through });
      findRoutes(snapshot, { start });
      findRoutes(snapshot, {});
      const second = findRoutes(snapshot, { start, end, through });

      expect(second).toEqual(first);
      expect({ edges: snapshot.edgeCount, nodes: sorted(snapshot.nodes.keys()), index: sorted(snapshot.filterIndex.get('start')!) }).toEqual(before);
    });
  });
});
