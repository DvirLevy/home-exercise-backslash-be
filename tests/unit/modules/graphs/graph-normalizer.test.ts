import { PayloadTooLargeError, ValidationError } from '../../../../src/http/errors';
import { parseGraphFile } from '../../../../src/modules/graphs/ingestion/graph-file.schema';
import { normalizeGraph, type GraphLimits } from '../../../../src/modules/graphs/ingestion/graph-normalizer';
import { SAMPLE_EXPECTED, sampleGraphJson } from '../../../helpers/sample-graph-file';

const LIMITS: GraphLimits = { maxNodes: 1_000, maxEdges: 1_000 };

/** Builds a validated file from node names (kind "service") and edge entries. */
function normalize(
  nodeNames: string[],
  edges: Array<{ from: string; to: string | string[] }>,
  limits: GraphLimits = LIMITS,
  nodeOverrides: Record<string, unknown> = {},
) {
  const file = parseGraphFile({
    nodes: nodeNames.map((name) => ({ name, kind: 'service', ...nodeOverrides })),
    edges,
  });
  return normalizeGraph(file, limits);
}

const pairs = (result: ReturnType<typeof normalize>) => result.edges.map((e) => `${e.from}>${e.to}`);

describe('normalizeGraph', () => {
  describe('edges', () => {
    it('splits an array "to" into one edge per target and accepts a single string', () => {
      const result = normalize(['a', 'b', 'c', 'd'], [
        { from: 'a', to: ['b', 'c'] },
        { from: 'b', to: 'd' },
      ]);

      expect(pairs(result)).toEqual(['a>b', 'a>c', 'b>d']);
    });

    it('merges duplicate edges, within one entry and across entries', () => {
      const result = normalize(['a', 'b', 'c'], [
        { from: 'a', to: ['b', 'b', 'c'] },
        { from: 'a', to: 'b' },
        { from: 'a', to: ['c'] },
      ]);

      expect(pairs(result)).toEqual(['a>b', 'a>c']);
    });

    it('treats the reverse direction as a different edge', () => {
      expect(pairs(normalize(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]))).toEqual(['a>b', 'b>a']);
    });

    it('keeps self-loops', () => {
      expect(pairs(normalize(['a'], [{ from: 'a', to: 'a' }]))).toEqual(['a>a']);
    });

    it('does not confuse names that merely share a prefix when merging', () => {
      const result = normalize(['a', 'ab', 'b'], [{ from: 'a', to: 'b' }, { from: 'ab', to: 'b' }, { from: 'a', to: 'ab' }]);

      expect(result.edges).toHaveLength(3);
    });

    it('produces no edges for an empty "to" list', () => {
      expect(normalize(['a'], [{ from: 'a', to: [] }]).edges).toEqual([]);
    });
  });

  describe('unknown fields', () => {
    const run = (top: Record<string, unknown>) => normalizeGraph(parseGraphFile({ nodes: [], edges: [], ...top }), LIMITS);

    it('passes the unknown top-level fields through', () => {
      expect(run({ title: 'Train Ticket', revision: 7 }).extra).toEqual({ title: 'Train Ticket', revision: 7 });
      expect(run({}).extra).toBeNull();
    });

    it('copies an entry\'s unknown fields onto every edge it expands to', () => {
      const result = normalizeGraph(
        parseGraphFile({
          nodes: [],
          edges: [{ from: 'a', to: ['b', 'c'], protocol: 'grpc' }, { from: 'b', to: 'c' }],
        }),
        LIMITS,
      );

      expect(result.edges).toEqual([
        { from: 'a', to: 'b', extra: { protocol: 'grpc' } },
        { from: 'a', to: 'c', extra: { protocol: 'grpc' } },
        { from: 'b', to: 'c', extra: null },
      ]);
    });

    it('gives each expanded edge its own object, so they never share state', () => {
      const result = normalizeGraph(parseGraphFile({ nodes: [], edges: [{ from: 'a', to: ['b', 'c'], tag: 1 }] }), LIMITS);

      expect(result.edges[0]?.extra).not.toBe(result.edges[1]?.extra);
    });

    it('merges the unknown fields of duplicate edge entries: keys are united, the later entry wins a conflict', () => {
      const result = normalizeGraph(
        parseGraphFile({
          nodes: [],
          edges: [
            { from: 'a', to: 'b', weight: 1, label: 'first' },
            { from: 'a', to: ['b'], weight: 2, color: 'red' },
            { from: 'a', to: 'b' }, // no unknown fields: changes nothing
          ],
        }),
        LIMITS,
      );

      expect(result.edges).toEqual([{ from: 'a', to: 'b', extra: { weight: 2, label: 'first', color: 'red' } }]);
    });

    it('keeps the unknown fields of a duplicate that only the second entry has', () => {
      const result = normalizeGraph(
        parseGraphFile({ nodes: [], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b', note: 'late' }] }),
        LIMITS,
      );

      expect(result.edges[0]?.extra).toEqual({ note: 'late' });
    });

    it('does not let a duplicate entry change the extra of an unrelated edge', () => {
      const result = normalizeGraph(
        parseGraphFile({ nodes: [], edges: [{ from: 'a', to: 'b', k: 1 }, { from: 'a', to: 'c', k: 2 }, { from: 'a', to: 'b', k: 3 }] }),
        LIMITS,
      );

      expect(result.edges.map((e) => e.extra)).toEqual([{ k: 3 }, { k: 2 }]);
    });

    it('keeps a "__proto__" key through merging', () => {
      const result = normalizeGraph(
        parseGraphFile(JSON.parse('{"nodes":[],"edges":[{"from":"a","to":"b","__proto__":{"p":1}},{"from":"a","to":"b","y":2}]}')),
        LIMITS,
      );

      const extra = result.edges[0]?.extra as Record<string, unknown>;
      expect(Object.hasOwn(extra, '__proto__')).toBe(true);
      expect(extra.y).toBe(2);
      expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
    });

    it('does not count unknown fields towards the limits', () => {
      expect(run({ big: 'x'.repeat(10_000) }).extra).toEqual({ big: 'x'.repeat(10_000) });
    });
  });

  describe('nodes', () => {
    it('stores defined nodes in file order, with missing optional fields as null', () => {
      const result = normalize(['zeta', 'alpha'], []);

      expect(result.nodes.map((n) => n.name)).toEqual(['zeta', 'alpha']);
      expect(result.nodes[0]).toEqual({
        name: 'zeta',
        kind: 'service',
        language: null,
        path: null,
        publicExposed: null,
        isPlaceholder: false,
        vulnerabilities: [],
        metadata: null,
        extra: null,
      });
    });

    it('carries extra fields through to the stored node', () => {
      const result = normalize(['a'], [], LIMITS, { owner: 'team-a' });

      expect(result.nodes[0]?.extra).toEqual({ owner: 'team-a' });
    });

    it('rejects duplicate names with a path for every repeat', () => {
      expect.assertions(4);
      try {
        normalize(['a', 'b', 'a', 'c', 'b', 'a'], []);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err).toMatchObject({ status: 400, code: 'DUPLICATE_NODE_NAME' });
        const details = (err as ValidationError).details ?? [];
        expect(details.map((d) => d.path)).toEqual(['nodes.2.name', 'nodes.4.name', 'nodes.5.name']);
        expect(details[0]?.message).toContain('first defined at nodes.0');
      }
    });

    it('caps the number of reported duplicates', () => {
      const names = Array.from({ length: 200 }, () => 'same');

      expect.assertions(1);
      try {
        normalize(names, []);
      } catch (err) {
        expect((err as ValidationError).details).toHaveLength(50);
      }
    });
  });

  describe('placeholders', () => {
    it('creates one placeholder for a missing "to" node, however often it is referenced', () => {
      const result = normalize(['a', 'b'], [
        { from: 'a', to: ['ghost', 'b'] },
        { from: 'b', to: 'ghost' },
      ]);

      expect(result.placeholders).toEqual(['ghost']);
      expect(result.nodes.filter((n) => n.isPlaceholder)).toHaveLength(1);
      expect(pairs(result)).toEqual(['a>ghost', 'a>b', 'b>ghost']);
    });

    it('creates a placeholder for a missing "from" node too', () => {
      const result = normalize(['a'], [{ from: 'ghost', to: 'a' }]);

      expect(result.placeholders).toEqual(['ghost']);
      expect(pairs(result)).toEqual(['ghost>a']);
    });

    it('creates a placeholder for a missing "from" node even without targets', () => {
      expect(normalize(['a'], [{ from: 'ghost', to: [] }]).placeholders).toEqual(['ghost']);
    });

    it('holds only the name: no invented metadata', () => {
      const result = normalize(['a'], [{ from: 'a', to: 'ghost' }]);

      expect(result.nodes[1]).toEqual({
        name: 'ghost',
        kind: null,
        language: null,
        path: null,
        publicExposed: null,
        isPlaceholder: true,
        vulnerabilities: [],
        metadata: null,
        extra: null,
      });
    });

    it('appends placeholders after the defined nodes, in order of first reference', () => {
      const result = normalize(['a'], [
        { from: 'a', to: ['second', 'first'] },
        { from: 'third', to: 'first' },
      ]);

      expect(result.nodes.map((n) => n.name)).toEqual(['a', 'second', 'first', 'third']);
      expect(result.placeholders).toEqual(['second', 'first', 'third']);
    });

    it('creates none when every reference is defined', () => {
      const result = normalize(['a', 'b'], [{ from: 'a', to: 'b' }]);

      expect(result.placeholders).toEqual([]);
      expect(result.nodes.every((n) => !n.isPlaceholder)).toBe(true);
    });
  });

  describe('limits', () => {
    it('rejects more nodes than allowed with 413, accepts exactly the limit', () => {
      expect(() => normalize(['a', 'b', 'c'], [], { maxNodes: 2, maxEdges: 10 })).toThrow(PayloadTooLargeError);
      expect(normalize(['a', 'b'], [], { maxNodes: 2, maxEdges: 10 }).nodes).toHaveLength(2);
    });

    it('counts placeholders towards the node limit', () => {
      expect(() => normalize(['a', 'b'], [{ from: 'a', to: 'ghost' }], { maxNodes: 2, maxEdges: 10 })).toThrow(
        /more nodes than allowed/,
      );
    });

    it('rejects more edges than allowed with 413, accepts exactly the limit', () => {
      const edges = [{ from: 'a', to: ['b', 'c', 'd'] }];

      expect(() => normalize(['a', 'b', 'c', 'd'], edges, { maxNodes: 10, maxEdges: 2 })).toThrow(PayloadTooLargeError);
      expect(normalize(['a', 'b', 'c', 'd'], edges, { maxNodes: 10, maxEdges: 3 }).edges).toHaveLength(3);
    });

    it('counts edges after merging duplicates', () => {
      const edges = [{ from: 'a', to: Array.from({ length: 100 }, () => 'b') }];

      expect(normalize(['a', 'b'], edges, { maxNodes: 10, maxEdges: 1 }).edges).toHaveLength(1);
    });

    it('reports a 413 with the limit in the message', () => {
      expect(() => normalize(['a', 'b', 'c'], [], { maxNodes: 2, maxEdges: 10 })).toThrow(
        expect.objectContaining({ status: 413, message: expect.stringContaining('maximum 2') }),
      );
    });
  });

  describe('sample file', () => {
    it('yields 47 nodes, 98 edges and the one placeholder', () => {
      const result = normalizeGraph(parseGraphFile(sampleGraphJson()), LIMITS);

      expect(result.nodes).toHaveLength(SAMPLE_EXPECTED.nodes);
      expect(result.edges).toHaveLength(SAMPLE_EXPECTED.edges);
      expect(result.placeholders).toEqual(SAMPLE_EXPECTED.placeholders);
    });

    it('keeps file order, with the placeholder last', () => {
      const result = normalizeGraph(parseGraphFile(sampleGraphJson()), LIMITS);

      expect(result.nodes[0]?.name).toBe('frontend');
      expect(result.nodes[45]?.name).toBe('prod-sqs');
      expect(result.nodes[46]).toMatchObject({ name: 'assurance-service', isPlaceholder: true });
    });

    it('expands the single-string edge and keeps vulnerabilities and metadata', () => {
      const result = normalizeGraph(parseGraphFile(sampleGraphJson()), LIMITS);

      expect(result.edges).toContainEqual({ from: 'consign-service', to: 'consign-price-service', extra: null });
      expect(result.nodes.find((n) => n.name === 'order-service')?.vulnerabilities).toHaveLength(2);
      expect(result.nodes.find((n) => n.name === 'prod-postgresdb')?.metadata).toEqual({
        cloud: 'AWS',
        engine: 'postgres',
        version: '9.6',
      });
    });

    it('stores a missing publicExposed as null (rds, sqs) and false as false', () => {
      const result = normalizeGraph(parseGraphFile(sampleGraphJson()), LIMITS);
      const byName = new Map(result.nodes.map((n) => [n.name, n]));

      expect(byName.get('prod-postgresdb')?.publicExposed).toBeNull();
      expect(byName.get('prod-sqs')?.publicExposed).toBeNull();
      expect(byName.get('auth-service')?.publicExposed).toBe(false);
      expect(byName.get('frontend')?.publicExposed).toBe(true);
    });

    it('finds no extra fields in the sample (every field is a known one)', () => {
      const result = normalizeGraph(parseGraphFile(sampleGraphJson()), LIMITS);

      expect(result.nodes.every((n) => n.extra === null)).toBe(true);
    });
  });
});
