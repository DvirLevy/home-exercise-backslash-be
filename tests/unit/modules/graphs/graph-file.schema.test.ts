import { ZodError } from 'zod';
import { GraphFileSchema, parseGraphFile } from '../../../../src/modules/graphs/ingestion/graph-file.schema';
import { sampleGraphJson } from '../../../helpers/sample-graph-file';

const node = (extra: Record<string, unknown> = {}) => ({ name: 'a', kind: 'service', ...extra });
const file = (nodes: unknown[], edges: unknown[] = [], top: Record<string, unknown> = {}) => ({ nodes, edges, ...top });

function issuePaths(input: unknown): string[] {
  const result = GraphFileSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

/** Parses JSON text the way an upload does, so keys like "__proto__" become real own keys. */
const fromJson = (text: string) => parseGraphFile(JSON.parse(text));

describe('parseGraphFile', () => {
  it('accepts the sample file', () => {
    const parsed = parseGraphFile(sampleGraphJson());

    expect(parsed.nodes).toHaveLength(46);
    expect(parsed.edges).toHaveLength(27);
    expect(parsed.extra).toBeNull();
  });

  describe('validation of the real content', () => {
    it.each([
      ['an array', []],
      ['a string', 'x'],
      ['a number', 3],
      ['null', null],
    ])('rejects %s', (_label, input) => {
      expect(() => parseGraphFile(input)).toThrow(ZodError);
    });

    it('requires both nodes and edges', () => {
      expect(issuePaths({ edges: [] })).toEqual(['nodes']);
      expect(issuePaths({ nodes: [] })).toEqual(['edges']);
    });

    it('accepts empty lists', () => {
      expect(parseGraphFile(file([]))).toMatchObject({ nodes: [], edges: [], extra: null });
    });

    it('requires name and kind on every node', () => {
      expect(issuePaths(file([{ kind: 'service' }]))).toEqual(['nodes.0.name']);
      expect(issuePaths(file([{ name: 'a' }]))).toEqual(['nodes.0.kind']);
      expect(issuePaths(file([{ name: '', kind: 'service' }]))).toEqual(['nodes.0.name']);
      expect(issuePaths(file([{ name: 'a', kind: '' }]))).toEqual(['nodes.0.kind']);
      expect(issuePaths(file([node(), { name: 5, kind: 'x' }]))).toEqual(['nodes.1.name']);
    });

    it('rejects a publicExposed that is not a boolean', () => {
      expect(issuePaths(file([node({ publicExposed: 'yes' })]))).toEqual(['nodes.0.publicExposed']);
      expect(issuePaths(file([node({ publicExposed: 1 })]))).toEqual(['nodes.0.publicExposed']);
    });

    it('rejects wrongly typed language, path, metadata and vulnerabilities', () => {
      expect(issuePaths(file([node({ language: 5 })]))).toEqual(['nodes.0.language']);
      expect(issuePaths(file([node({ path: [] })]))).toEqual(['nodes.0.path']);
      expect(issuePaths(file([node({ metadata: 'x' })]))).toEqual(['nodes.0.metadata']);
      expect(issuePaths(file([node({ metadata: [] })]))).toEqual(['nodes.0.metadata']);
      expect(issuePaths(file([node({ vulnerabilities: {} })]))).toEqual(['nodes.0.vulnerabilities']);
    });

    it('rejects vulnerabilities that are not objects or whose known fields have the wrong type', () => {
      expect(issuePaths(file([node({ vulnerabilities: ['x'] })]))).toEqual(['nodes.0.vulnerabilities.0']);
      expect(issuePaths(file([node({ vulnerabilities: [{ severity: 3 }] })]))).toEqual(['nodes.0.vulnerabilities.0.severity']);
      expect(issuePaths(file([node({ vulnerabilities: [{ metadata: 'x' }] })]))).toEqual(['nodes.0.vulnerabilities.0.metadata']);
    });

    it('accepts any severity string (the file does not define the set)', () => {
      expect(() => parseGraphFile(file([node({ vulnerabilities: [{ severity: 'catastrophic' }] })]))).not.toThrow();
    });

    it('accepts "to" as a string or an array of strings, and rejects anything else', () => {
      expect(() => parseGraphFile(file([], [{ from: 'a', to: 'b' }]))).not.toThrow();
      expect(() => parseGraphFile(file([], [{ from: 'a', to: ['b', 'c'] }]))).not.toThrow();
      expect(() => parseGraphFile(file([], [{ from: 'a', to: [] }]))).not.toThrow();

      const result = GraphFileSchema.safeParse(file([], [{ from: 'a', to: 5 }]));
      expect(result.error?.issues[0]).toMatchObject({ path: ['edges', 0, 'to'], message: 'must be a string or an array of strings' });
      expect(issuePaths(file([], [{ from: 'a', to: ['b', 5] }]))).not.toEqual([]);
    });

    it('requires non-empty "from" and "to" values', () => {
      expect(issuePaths(file([], [{ to: 'b' }]))).toEqual(['edges.0.from']);
      expect(issuePaths(file([], [{ from: '', to: 'b' }]))).toEqual(['edges.0.from']);
      expect(issuePaths(file([], [{ from: 'a' }]))).toEqual(['edges.0.to']);
      expect(issuePaths(file([], [{ from: 'a', to: [''] }]))).not.toEqual([]);
    });
  });

  describe('known node fields', () => {
    it('reads them as given', () => {
      const [parsed] = parseGraphFile(
        file([node({ language: 'java', path: 'svc/a', publicExposed: true, metadata: { cloud: 'AWS' } })]),
      ).nodes;

      expect(parsed).toMatchObject({ language: 'java', path: 'svc/a', publicExposed: true, metadata: { cloud: 'AWS' } });
    });

    it('turns absent and null optional fields into null (and no vulnerabilities into [])', () => {
      const [absent, explicitNull] = parseGraphFile(
        file([node(), node({ name: 'b', language: null, path: null, publicExposed: null, metadata: null, vulnerabilities: null })]),
      ).nodes;

      const expected = { language: null, path: null, publicExposed: null, metadata: null, vulnerabilities: [], extra: null };
      expect(absent).toMatchObject(expected);
      expect(explicitNull).toMatchObject(expected);
    });

    it('keeps false (an explicit "not exposed") distinct from missing', () => {
      expect(parseGraphFile(file([node({ publicExposed: false })])).nodes[0]?.publicExposed).toBe(false);
    });
  });

  describe('unknown fields are preserved at every level', () => {
    const awkward = { nested: { list: [1, { deep: true }, null, 'x', false, 0, ''] }, empty: {}, unicode: 'שלום ü', nil: null };

    it('on the file itself', () => {
      const parsed = parseGraphFile(file([], [], { title: 'Train Ticket', owner: { team: 'a' }, revision: 7, ...awkward }));

      expect(parsed.extra).toEqual({ title: 'Train Ticket', owner: { team: 'a' }, revision: 7, ...awkward });
    });

    it('on a node, leaving the known fields out of it', () => {
      const [parsed] = parseGraphFile(file([node({ language: 'java', owner: 'team-a', tier: 2, ...awkward })])).nodes;

      expect(parsed?.extra).toEqual({ owner: 'team-a', tier: 2, ...awkward });
      expect(parsed?.language).toBe('java');
    });

    it('on an edge entry, leaving "from" and "to" out of it', () => {
      const [edge] = parseGraphFile(file([], [{ from: 'a', to: ['b', 'c'], protocol: 'grpc', ...awkward }])).edges;

      expect(edge).toMatchObject({ from: 'a', to: ['b', 'c'] });
      expect(edge?.extra).toEqual({ protocol: 'grpc', ...awkward });
    });

    it('on a vulnerability, together with its known fields', () => {
      const vulnerability = { file: 'a.java', severity: 'high', message: 'bad', metadata: { cwe: 'CWE-22', extraMeta: [1] }, scanner: 'semgrep', ...awkward };

      const [parsed] = parseGraphFile(file([node({ vulnerabilities: [vulnerability] })])).nodes;

      expect(parsed?.vulnerabilities).toEqual([vulnerability]);
    });

    it('inside node metadata, whatever the values', () => {
      const metadata = { cloud: 'AWS', port: 5432, tls: true, tags: ['a', 'b'], nested: { x: null } };

      expect(parseGraphFile(file([node({ metadata })])).nodes[0]?.metadata).toEqual(metadata);
    });

    it('is null when a level has no unknown fields', () => {
      const parsed = parseGraphFile(file([node()], [{ from: 'a', to: 'b' }]));

      expect(parsed.extra).toBeNull();
      expect(parsed.nodes[0]?.extra).toBeNull();
      expect(parsed.edges[0]?.extra).toBeNull();
    });

    it('does not mistake a field that shares a name with ours for ours', () => {
      const parsed = fromJson(
        '{"nodes":[{"name":"a","kind":"s","extra":1,"placeholder":true,"isPlaceholder":true,"position":9}],' +
          '"edges":[{"from":"a","to":"b","extra":2,"graphId":"x"}],"extra":3,"id":"top","version":99}',
      );

      expect(parsed.extra).toEqual({ extra: 3, id: 'top', version: 99 });
      expect(parsed.nodes[0]?.extra).toEqual({ extra: 1, placeholder: true, isPlaceholder: true, position: 9 });
      expect(parsed.edges[0]?.extra).toEqual({ extra: 2, graphId: 'x' });
    });

    it('keeps the order of the keys as written', () => {
      const parsed = fromJson('{"nodes":[],"edges":[],"zeta":1,"alpha":2,"mid":3}');

      expect(Object.keys(parsed.extra ?? {})).toEqual(['zeta', 'alpha', 'mid']);
    });

    describe('a "__proto__" key never pollutes prototypes (uploads containing one are refused earlier, by parseJsonBuffer)', () => {
      const payload = '{"x":1,"__proto__":{"polluted":true}}';
      const withProto = (level: string) =>
        level === 'file'
          ? fromJson(`{"nodes":[],"edges":[],"__proto__":{"polluted":true},"x":1}`)
          : level === 'node'
            ? fromJson(`{"nodes":[{"name":"a","kind":"s","x":1,"__proto__":{"polluted":true}}],"edges":[]}`)
            : fromJson(`{"nodes":[],"edges":[{"from":"a","to":"b","x":1,"__proto__":{"polluted":true}}]}`);
      const extraOf = (level: string) => {
        const parsed = withProto(level);
        return level === 'file' ? parsed.extra : level === 'node' ? parsed.nodes[0]?.extra : parsed.edges[0]?.extra;
      };

      it.each(['file', 'node', 'edge'])('is handled as an ordinary key on a %s', (level) => {
        const extra = extraOf(level)!;

        expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
        expect(Object.hasOwn(extra, '__proto__')).toBe(true);
        expect(JSON.parse(JSON.stringify(extra))).toEqual(JSON.parse(payload));
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((extra as Record<string, unknown>).polluted).toBeUndefined();
      });

      it('is kept inside a vulnerability too', () => {
        const parsed = fromJson('{"nodes":[{"name":"a","kind":"s","vulnerabilities":[{"severity":"low","__proto__":{"p":1}}]}],"edges":[]}');
        const vulnerability = parsed.nodes[0]?.vulnerabilities[0] as Record<string, unknown>;

        expect(Object.hasOwn(vulnerability, '__proto__')).toBe(true);
        expect(Object.getPrototypeOf(vulnerability)).toBe(Object.prototype);
      });
    });
  });
});
