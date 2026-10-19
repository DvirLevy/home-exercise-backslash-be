import { BUILTIN_FILTERS } from '../../../../../src/modules/filters/builtin-filters';
import { compileRule } from '../../../../../src/modules/filters/rules/rule.compiler';
import { parseRule } from '../../../../../src/modules/filters/rules/rule.schema';
import type { FilterableNode, Rule } from '../../../../../src/modules/filters/rules/rule.types';
import { normalizeGraph } from '../../../../../src/modules/graphs/ingestion/graph-normalizer';
import { parseGraphFile } from '../../../../../src/modules/graphs/ingestion/graph-file.schema';
import { sampleGraphJson } from '../../../../helpers/sample-graph-file';

function node(overrides: Partial<FilterableNode> = {}): FilterableNode {
  return {
    name: 'svc',
    kind: 'service',
    language: null,
    path: null,
    publicExposed: null,
    vulnerabilities: [],
    metadata: null,
    extra: null,
    ...overrides,
  };
}

/** Parses (so every rule used here is also a valid one), compiles and evaluates. */
function matches(rule: unknown, subject: FilterableNode): boolean {
  return compileRule(parseRule(rule))(subject);
}

describe('compileRule', () => {
  describe('eq / neq', () => {
    it('compares strictly: same type and value', () => {
      expect(matches({ field: 'kind', op: 'eq', value: 'rds' }, node({ kind: 'rds' }))).toBe(true);
      expect(matches({ field: 'kind', op: 'eq', value: 'rds' }, node({ kind: 'RDS' }))).toBe(false);
      expect(matches({ field: 'metadata.port', op: 'eq', value: 5432 }, node({ metadata: { port: 5432 } }))).toBe(true);
      expect(matches({ field: 'metadata.port', op: 'eq', value: 5432 }, node({ metadata: { port: '5432' } }))).toBe(false);
      expect(matches({ field: 'metadata.on', op: 'eq', value: true }, node({ metadata: { on: 1 } }))).toBe(false);
    });

    it('treats only a real true as public', () => {
      const rule = { field: 'publicExposed', op: 'eq', value: true };

      expect(matches(rule, node({ publicExposed: true }))).toBe(true);
      expect(matches(rule, node({ publicExposed: false }))).toBe(false);
      expect(matches(rule, node({ publicExposed: null }))).toBe(false);
    });

    it('never matches an object or an array value', () => {
      expect(matches({ field: 'metadata.tags', op: 'eq', value: 'a' }, node({ metadata: { tags: ['a'] } }))).toBe(false);
      expect(matches({ field: 'metadata.o', op: 'eq', value: null }, node({ metadata: { o: {} } }))).toBe(false);
    });

    it('lets eq null match a missing or null field', () => {
      const rule = { field: 'language', op: 'eq', value: null };

      expect(matches(rule, node({ language: null }))).toBe(true);
      expect(matches(rule, node({ language: 'java' }))).toBe(false);
      expect(matches({ field: 'metadata.x', op: 'eq', value: null }, node({ metadata: {} }))).toBe(true);
    });

    it('makes neq the exact complement of eq, including for a missing field', () => {
      const eq = { field: 'language', op: 'eq', value: 'java' };
      const neq = { field: 'language', op: 'neq', value: 'java' };

      for (const language of ['java', 'go', null]) {
        expect(matches(neq, node({ language }))).toBe(!matches(eq, node({ language })));
      }
      expect(matches(neq, node({ language: null }))).toBe(true);
    });
  });

  describe('a field that is absent (not just null)', () => {
    const absentCases: Array<[string, string, FilterableNode]> = [
      ['a metadata key that is not there', 'metadata.x', node({ metadata: { other: 1 } })],
      ['metadata that is null', 'metadata.x', node({ metadata: null })],
      ['a path that runs into a string', 'metadata.x.y', node({ metadata: { x: 'text' } })],
      ['an unknown field that is not there', 'extra.x.y', node({ extra: {} })],
    ];

    it.each(absentCases)('is satisfied by neq, notIn and notExists, and by nothing else: %s', (_label, path, subject) => {
      expect(matches({ field: path, op: 'neq', value: 'a' }, subject)).toBe(true);
      expect(matches({ field: path, op: 'notIn', value: ['a'] }, subject)).toBe(true);
      expect(matches({ field: path, op: 'notExists' }, subject)).toBe(true);
      expect(matches({ field: path, op: 'eq', value: 'a' }, subject)).toBe(false);
      expect(matches({ field: path, op: 'in', value: ['a'] }, subject)).toBe(false);
      expect(matches({ field: path, op: 'exists' }, subject)).toBe(false);
      expect(matches({ field: path, op: 'contains', value: 'a' }, subject)).toBe(false);
      expect(matches({ field: path, op: 'gt', value: 0 }, subject)).toBe(false);
    });
  });

  describe('in / notIn', () => {
    it('matches when the value is one of the listed ones', () => {
      const rule = { field: 'kind', op: 'in', value: ['rds', 'sql'] };

      expect(matches(rule, node({ kind: 'rds' }))).toBe(true);
      expect(matches(rule, node({ kind: 'sql' }))).toBe(true);
      expect(matches(rule, node({ kind: 'sqs' }))).toBe(false);
      expect(matches(rule, node({ kind: null }))).toBe(false);
    });

    it('is strict about types and handles mixed lists and null', () => {
      const rule = { field: 'metadata.v', op: 'in', value: [1, 'a', true, null] };

      expect(matches(rule, node({ metadata: { v: 1 } }))).toBe(true);
      expect(matches(rule, node({ metadata: { v: '1' } }))).toBe(false);
      expect(matches(rule, node({ metadata: { v: true } }))).toBe(true);
      expect(matches(rule, node({ metadata: { other: 1 } }))).toBe(true); // missing = null, which is listed
      expect(matches(rule, node({ metadata: { v: { a: 1 } } }))).toBe(false);
    });

    it('never matches an empty list; notIn always does', () => {
      expect(matches({ field: 'kind', op: 'in', value: [] }, node())).toBe(false);
      expect(matches({ field: 'kind', op: 'notIn', value: [] }, node())).toBe(true);
    });

    it('makes notIn the exact complement of in', () => {
      for (const kind of ['rds', 'sql', 'sqs', null]) {
        const subject = node({ kind });
        expect(matches({ field: 'kind', op: 'notIn', value: ['rds', 'sql'] }, subject)).toBe(
          !matches({ field: 'kind', op: 'in', value: ['rds', 'sql'] }, subject),
        );
      }
    });
  });

  describe('exists / notExists', () => {
    it('treats absent and null as missing, and everything else (even false, 0 and "") as present', () => {
      const exists = { field: 'metadata.v', op: 'exists' };
      const notExists = { field: 'metadata.v', op: 'notExists' };

      const cases: Array<[FilterableNode['metadata'], boolean]> = [
        [{ v: 'x' }, true],
        [{ v: false }, true],
        [{ v: 0 }, true],
        [{ v: '' }, true],
        [{ v: {} }, true],
        [{ v: [] }, true],
        [{ v: null }, false],
        [{}, false],
        [null, false],
      ];
      for (const [metadata, present] of cases) {
        expect(matches(exists, node({ metadata }))).toBe(present);
        expect(matches(notExists, node({ metadata }))).toBe(!present);
      }
    });

    it('works on the scalar fields', () => {
      expect(matches({ field: 'language', op: 'exists' }, node({ language: 'java' }))).toBe(true);
      expect(matches({ field: 'language', op: 'exists' }, node({ language: null }))).toBe(false);
      expect(matches({ field: 'publicExposed', op: 'exists' }, node({ publicExposed: false }))).toBe(true);
    });
  });

  describe('contains', () => {
    const rule = { field: 'path', op: 'contains', value: 'ts-auth' };

    it('matches a substring, case-sensitively', () => {
      expect(matches(rule, node({ path: 'train-ticket/ts-auth-service' }))).toBe(true);
      expect(matches(rule, node({ path: 'train-ticket/TS-AUTH-service' }))).toBe(false);
      expect(matches(rule, node({ path: 'other' }))).toBe(false);
    });

    it('only applies to strings', () => {
      expect(matches(rule, node({ path: null }))).toBe(false);
      expect(matches({ field: 'metadata.n', op: 'contains', value: '1' }, node({ metadata: { n: 123 } }))).toBe(false);
      expect(matches({ field: 'metadata.l', op: 'contains', value: 'a' }, node({ metadata: { l: ['a'] } }))).toBe(false);
    });
  });

  describe('gt / gte / lt / lte', () => {
    it.each([
      ['gt', 5, 6, true],
      ['gt', 5, 5, false],
      ['gt', 5, 4, false],
      ['gte', 5, 5, true],
      ['gte', 5, 4, false],
      ['lt', 5, 4, true],
      ['lt', 5, 5, false],
      ['lte', 5, 5, true],
      ['lte', 5, 6, false],
      ['gt', -1, 0, true],
      ['lt', 0.5, 0.25, true],
    ])('%s %d against %d is %s', (op, limit, actual, expected) => {
      expect(matches({ field: 'metadata.n', op, value: limit }, node({ metadata: { n: actual } }))).toBe(expected);
    });

    it('is false for anything that is not a number, even if it looks like one', () => {
      for (const op of ['gt', 'gte', 'lt', 'lte']) {
        for (const value of ['10', null, true, [10], { n: 10 }]) {
          expect(matches({ field: 'metadata.n', op, value: 5 }, node({ metadata: { n: value as never } }))).toBe(false);
        }
        expect(matches({ field: 'metadata.n', op, value: 5 }, node())).toBe(false); // missing
      }
    });
  });

  describe('field paths', () => {
    it('reads the single-valued fields', () => {
      expect(matches({ field: 'name', op: 'eq', value: 'x' }, node({ name: 'x' }))).toBe(true);
      expect(matches({ field: 'language', op: 'eq', value: 'java' }, node({ language: 'java' }))).toBe(true);
      expect(matches({ field: 'path', op: 'eq', value: 'p' }, node({ path: 'p' }))).toBe(true);
    });

    it('follows dotted paths into metadata and into the unknown fields', () => {
      const subject = node({ metadata: { db: { engine: 'postgres', replicas: 2 } }, extra: { team: { name: 'platform' } } });

      expect(matches({ field: 'metadata.db.engine', op: 'eq', value: 'postgres' }, subject)).toBe(true);
      expect(matches({ field: 'metadata.db.replicas', op: 'gte', value: 2 }, subject)).toBe(true);
      expect(matches({ field: 'extra.team.name', op: 'eq', value: 'platform' }, subject)).toBe(true);
      expect(matches({ field: 'extra.team.name', op: 'eq', value: 'other' }, subject)).toBe(false);
    });

    it('is false (not an error) when the path leads nowhere', () => {
      const subject = node({ metadata: { a: 'text', list: [1, 2] } });

      expect(matches({ field: 'metadata.missing', op: 'eq', value: 'x' }, subject)).toBe(false);
      expect(matches({ field: 'metadata.a.deeper', op: 'eq', value: 'x' }, subject)).toBe(false); // runs into a string
      expect(matches({ field: 'metadata.list.0', op: 'eq', value: 1 }, subject)).toBe(false); // arrays are not indexed
      expect(matches({ field: 'extra.x', op: 'eq', value: 'x' }, node({ extra: null }))).toBe(false);
      expect(matches({ field: 'metadata.x', op: 'exists' }, node({ metadata: null }))).toBe(false);
    });

    it('never follows inherited properties, so special names cannot be reached', () => {
      const subject = node({ metadata: {}, extra: {} });

      for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
        expect(matches({ field: `metadata.${key}`, op: 'exists' }, subject)).toBe(false);
        expect(matches({ field: `extra.${key}.x`, op: 'exists' }, subject)).toBe(false);
      }
    });

    it('does reach such a name when the data really has it as its own key', () => {
      const own = JSON.parse('{"constructor":"mine","__proto__":{"a":1}}') as Record<string, never>;

      expect(matches({ field: 'metadata.constructor', op: 'eq', value: 'mine' }, node({ metadata: own }))).toBe(true);
    });
  });

  describe('combinators', () => {
    const rds = node({ kind: 'rds', publicExposed: false });
    const web = node({ kind: 'service', publicExposed: true });

    it('all needs every rule', () => {
      const rule = { all: [{ field: 'kind', op: 'eq', value: 'service' }, { field: 'publicExposed', op: 'eq', value: true }] };

      expect(matches(rule, web)).toBe(true);
      expect(matches(rule, rds)).toBe(false);
    });

    it('any needs one rule', () => {
      const rule = { any: [{ field: 'kind', op: 'eq', value: 'rds' }, { field: 'publicExposed', op: 'eq', value: true }] };

      expect(matches(rule, rds)).toBe(true);
      expect(matches(rule, web)).toBe(true);
      expect(matches(rule, node({ kind: 'sqs' }))).toBe(false);
    });

    it('not inverts, and nests', () => {
      const rule = {
        all: [
          { not: { field: 'kind', op: 'eq', value: 'rds' } },
          { any: [{ field: 'publicExposed', op: 'eq', value: true }, { not: { field: 'name', op: 'exists' } }] },
        ],
      };

      expect(matches(rule, web)).toBe(true);
      expect(matches(rule, rds)).toBe(false);
    });

    it('stops evaluating once the answer is known (but never changes it)', () => {
      const rule = { any: [{ field: 'kind', op: 'eq', value: 'service' }, { field: 'metadata.deep.x', op: 'exists' }] };

      expect(matches(rule, web)).toBe(true);
    });
  });

  describe('vulnerabilities', () => {
    const withVulns = node({
      vulnerabilities: [
        { file: 'a/Service.java', severity: 'medium', message: 'SQL injection', metadata: { cwe: 'CWE-89', score: 6.5 } },
        { file: 'b/Order.java', severity: 'high', message: 'File open from tainted variable', metadata: { cwe: 'CWE-22', score: 8.1 }, scanner: 'semgrep' },
      ],
    });
    const some = (where?: unknown) => ({ field: 'vulnerabilities', op: 'some', ...(where ? { where } : {}) });

    it('"some" without "where" means at least one vulnerability', () => {
      expect(matches(some(), withVulns)).toBe(true);
      expect(matches(some(), node())).toBe(false);
    });

    it('"where" must hold for one vulnerability, not across several', () => {
      expect(matches(some({ field: 'severity', op: 'eq', value: 'high' }), withVulns)).toBe(true);
      expect(matches(some({ field: 'severity', op: 'eq', value: 'low' }), withVulns)).toBe(false);
      expect(matches(some({ all: [{ field: 'severity', op: 'eq', value: 'medium' }, { field: 'file', op: 'contains', value: 'Order' }] }), withVulns)).toBe(false);
      expect(matches(some({ all: [{ field: 'severity', op: 'eq', value: 'high' }, { field: 'file', op: 'contains', value: 'Order' }] }), withVulns)).toBe(true);
    });

    it('reads nested and unknown fields of a vulnerability', () => {
      expect(matches(some({ field: 'metadata.cwe', op: 'eq', value: 'CWE-22' }), withVulns)).toBe(true);
      expect(matches(some({ field: 'metadata.score', op: 'gte', value: 8 }), withVulns)).toBe(true);
      expect(matches(some({ field: 'metadata.score', op: 'gt', value: 9 }), withVulns)).toBe(false);
      expect(matches(some({ field: 'scanner', op: 'eq', value: 'semgrep' }), withVulns)).toBe(true);
      expect(matches(some({ field: 'scanner', op: 'notExists' }), withVulns)).toBe(true); // the first one has none
    });

    it('supports any / not inside "where"', () => {
      expect(matches(some({ any: [{ field: 'severity', op: 'in', value: ['high', 'critical'] }, { field: 'message', op: 'contains', value: 'zzz' }] }), withVulns)).toBe(true);
      expect(matches(some({ not: { field: 'severity', op: 'in', value: ['medium', 'high'] } }), withVulns)).toBe(false);
    });

    it('works inside the node-level combinators', () => {
      const rule = { all: [{ field: 'kind', op: 'eq', value: 'service' }, some({ field: 'severity', op: 'eq', value: 'high' })] };

      expect(matches(rule, withVulns)).toBe(true);
      expect(matches({ not: some() }, node())).toBe(true);
    });

    it('does not fail on vulnerabilities of odd shapes', () => {
      const odd = node({ vulnerabilities: [null, 'text', 5, [], {}, { severity: ['high'] }] as never });

      expect(matches(some({ field: 'severity', op: 'eq', value: 'high' }), odd)).toBe(false);
      expect(matches(some({ field: 'severity', op: 'notExists' }), odd)).toBe(true); // the empty {} has none
      expect(matches(some(), odd)).toBe(true);
    });

    it('is false if vulnerabilities is not a list at all', () => {
      expect(matches(some(), node({ vulnerabilities: null as never }))).toBe(false);
      expect(matches(some({ field: 'severity', op: 'exists' }), node({ vulnerabilities: {} as never }))).toBe(false);
    });
  });

  describe('safety', () => {
    it('never throws and never changes the node, whatever it holds', () => {
      const rules: Rule[] = [
        parseRule({ field: 'metadata.a.b', op: 'eq', value: 1 }),
        parseRule({ field: 'extra.x', op: 'contains', value: 'a' }),
        parseRule({ field: 'vulnerabilities', op: 'some', where: { field: 'metadata.cwe', op: 'exists' } }),
        parseRule({ not: { field: 'name', op: 'in', value: ['a'] } }),
      ];
      const subjects: FilterableNode[] = [
        node(),
        node({ metadata: { a: null } }),
        node({ metadata: { a: { b: [] } }, extra: { x: 5 } }),
        node({ vulnerabilities: [{ metadata: null }, { metadata: 3 }, null] as never }),
        node({ metadata: Object.create(null) as never }),
      ];
      const snapshotOf = JSON.stringify(subjects);

      for (const rule of rules) for (const subject of subjects) expect(() => compileRule(rule)(subject)).not.toThrow();

      expect(JSON.stringify(subjects)).toBe(snapshotOf);
    });

    it('compiles once and can then be evaluated many times with the same answer', () => {
      const predicate = compileRule(parseRule({ field: 'kind', op: 'eq', value: 'rds' }));

      expect([predicate(node({ kind: 'rds' })), predicate(node({ kind: 'rds' })), predicate(node())]).toEqual([true, true, false]);
    });
  });
});

describe('the built-in filters on the sample file', () => {
  const normalized = normalizeGraph(parseGraphFile(sampleGraphJson()), { maxNodes: 100, maxEdges: 200 });
  const namesMatching = (key: string): string[] => {
    const filter = BUILTIN_FILTERS.find((f) => f.key === key)!;
    const predicate = compileRule(parseRule(filter.definition));
    return normalized.nodes.filter((n) => predicate(n)).map((n) => n.name);
  };

  it('public: only frontend and gateway-service (publicExposed is true)', () => {
    expect(namesMatching('public')).toEqual(['frontend', 'gateway-service']);
  });

  it('sink: only the rds database, not the sqs queue', () => {
    expect(namesMatching('sink')).toEqual(['prod-postgresdb']);
  });

  it('vulnerable: the two nodes that list vulnerabilities', () => {
    expect(namesMatching('vulnerable')).toEqual(['auth-service', 'order-service']);
  });

  it('does not match the placeholder or a node whose publicExposed is missing', () => {
    expect(namesMatching('public')).not.toContain('assurance-service');
    expect(namesMatching('public')).not.toContain('prod-sqs');
    expect(namesMatching('vulnerable')).not.toContain('assurance-service');
  });
});
