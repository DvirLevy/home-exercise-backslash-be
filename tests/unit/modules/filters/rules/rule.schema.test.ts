import { ValidationError } from '../../../../../src/http/errors';
import { BUILTIN_FILTERS } from '../../../../../src/modules/filters/builtin-filters';
import { parseRule, validateRule } from '../../../../../src/modules/filters/rules/rule.schema';
import { RULE_LIMITS, type Rule } from '../../../../../src/modules/filters/rules/rule.types';

/** Paths of every problem found in `raw`, e.g. ["definition.all.1.value"]. */
function problems(raw: unknown): string[] {
  const result = validateRule(raw);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

function messages(raw: unknown): string[] {
  const result = validateRule(raw);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe('validateRule', () => {
  describe('accepts', () => {
    it.each(BUILTIN_FILTERS.map((f) => [f.key, f.definition] as const))('the built-in filter %s', (_key, definition) => {
      expect(validateRule(definition)).toEqual({ ok: true, rule: definition });
    });

    it.each<[string, unknown]>([
      ['eq', { field: 'kind', op: 'eq', value: 'rds' }],
      ['eq with null', { field: 'language', op: 'eq', value: null }],
      ['eq with a boolean', { field: 'publicExposed', op: 'eq', value: false }],
      ['eq with a number', { field: 'metadata.port', op: 'eq', value: 5432 }],
      ['neq', { field: 'kind', op: 'neq', value: 'sqs' }],
      ['in', { field: 'kind', op: 'in', value: ['rds', 'sql', null, 3, true] }],
      ['in with an empty list', { field: 'kind', op: 'in', value: [] }],
      ['notIn', { field: 'name', op: 'notIn', value: ['a'] }],
      ['exists', { field: 'metadata.engine', op: 'exists' }],
      ['notExists', { field: 'extra.owner', op: 'notExists' }],
      ['contains', { field: 'path', op: 'contains', value: 'ts-' }],
      ['gt', { field: 'metadata.port', op: 'gt', value: 1000 }],
      ['gte', { field: 'metadata.port', op: 'gte', value: 1000.5 }],
      ['lt', { field: 'metadata.port', op: 'lt', value: -1 }],
      ['lte', { field: 'metadata.port', op: 'lte', value: 0 }],
      ['some without where', { field: 'vulnerabilities', op: 'some' }],
      ['some with where', { field: 'vulnerabilities', op: 'some', where: { field: 'severity', op: 'eq', value: 'high' } }],
      ['all', { all: [{ field: 'kind', op: 'eq', value: 'rds' }, { field: 'name', op: 'exists' }] }],
      ['any', { any: [{ field: 'kind', op: 'eq', value: 'rds' }] }],
      ['not', { not: { field: 'kind', op: 'eq', value: 'rds' } }],
      ['a deep metadata path', { field: 'metadata.a.b.c', op: 'exists' }],
      ['a field of the unknown fields', { field: 'extra.team', op: 'eq', value: 'a' }],
    ])('%s', (_label, rule) => {
      expect(validateRule(rule).ok).toBe(true);
    });

    it('nested all / any / not', () => {
      const rule = {
        all: [
          { any: [{ field: 'kind', op: 'in', value: ['rds', 'sql'] }, { not: { field: 'publicExposed', op: 'eq', value: true } }] },
          { not: { any: [{ field: 'name', op: 'contains', value: 'test' }, { field: 'extra.skip', op: 'exists' }] } },
        ],
      };

      expect(validateRule(rule)).toEqual({ ok: true, rule });
    });

    it('any field inside a vulnerability condition, including unknown and nested ones', () => {
      const where = {
        all: [
          { field: 'severity', op: 'in', value: ['high', 'critical'] },
          { field: 'metadata.cwe', op: 'contains', value: 'CWE-22' },
          { field: 'scanner', op: 'exists' },
          { field: 'file', op: 'contains', value: '.java' },
          { field: 'metadata.score', op: 'gte', value: 7 },
        ],
      };

      expect(validateRule({ field: 'vulnerabilities', op: 'some', where }).ok).toBe(true);
    });
  });

  describe('rejects an operator', () => {
    it('that does not exist, naming the allowed ones', () => {
      expect(problems({ field: 'kind', op: 'equals', value: 'x' })).toEqual(['definition.op']);
      expect(messages({ field: 'kind', op: 'equals', value: 'x' })[0]).toContain('"eq"');
    });

    it.each([undefined, null, 5, ['eq'], {}])('that is %p', (op) => {
      expect(problems({ field: 'kind', op, value: 'x' })).toEqual(['definition.op']);
    });

    it('missing entirely', () => {
      expect(problems({ field: 'kind', value: 'x' })).toEqual(['definition.op']);
    });
  });

  describe('rejects a field', () => {
    it('that is not a known node field, listing the known ones', () => {
      expect(problems({ field: 'color', op: 'eq', value: 'red' })).toEqual(['definition.field']);
      expect(messages({ field: 'color', op: 'eq', value: 'red' })[0]).toContain('"publicExposed"');
    });

    it.each(['Kind', 'KIND', 'kind ', ' kind', 'is_placeholder', 'isPlaceholder', 'position', 'id', 'version'])(
      'that is %p (an internal or mistyped name)',
      (field) => {
        expect(problems({ field, op: 'eq', value: 'x' })).toEqual(['definition.field']);
      },
    );

    it.each([undefined, null, 3, '', {}, ['kind']])('that is %p', (field) => {
      expect(problems({ field, op: 'eq', value: 'x' })).toEqual(['definition.field']);
    });

    it('that tries to nest a single-valued field', () => {
      expect(problems({ field: 'kind.sub', op: 'eq', value: 'x' })).toEqual(['definition.field']);
      expect(messages({ field: 'name.first', op: 'exists' })[0]).toContain('cannot be nested');
    });

    it.each(['metadata', 'extra'])('"%s" without a key after it', (field) => {
      expect(problems({ field, op: 'exists' })).toEqual(['definition.field']);
    });

    it.each(['metadata.', '.metadata.x', 'metadata..x', 'metadata.a.', 'extra.'])('with an empty segment: %p', (field) => {
      expect(problems({ field, op: 'exists' })).toEqual(['definition.field']);
    });

    it('with too many segments or a segment that is too long or has control characters', () => {
      expect(problems({ field: 'metadata.a.b.c.d.e.f', op: 'exists' })).toEqual(['definition.field']);
      expect(problems({ field: `metadata.${'x'.repeat(RULE_LIMITS.maxSegmentLength + 1)}`, op: 'exists' })).toEqual(['definition.field']);
      expect(problems({ field: 'metadata.a\u0000b', op: 'exists' })).toEqual(['definition.field']);
      expect(problems({ field: 'metadata.a\nb', op: 'exists' })).toEqual(['definition.field']);
    });

    it('"vulnerabilities" with any operator but "some"', () => {
      expect(problems({ field: 'vulnerabilities', op: 'exists' })).toEqual(['definition.field']);
      expect(problems({ field: 'vulnerabilities', op: 'eq', value: 1 })).toEqual(['definition.field']);
      expect(messages({ field: 'vulnerabilities', op: 'exists' })[0]).toContain('"some"');
    });

    it('"some" on any field but "vulnerabilities"', () => {
      expect(problems({ field: 'metadata.tags', op: 'some' })).toEqual(['definition.field']);
      expect(problems({ field: 'kind', op: 'some' })).toEqual(['definition.field']);
    });

    it('"vulnerabilities.x"', () => {
      expect(problems({ field: 'vulnerabilities.severity', op: 'some' })).toEqual(['definition.field']);
    });
  });

  describe('rejects a value', () => {
    it('that is missing', () => {
      for (const op of ['eq', 'neq', 'in', 'notIn', 'contains', 'gt', 'gte', 'lt', 'lte']) {
        expect(problems({ field: 'name', op })).toEqual(['definition.value']);
      }
    });

    it.each<[string, string, unknown]>([
      ['eq', 'an object', { a: 1 }],
      ['eq', 'an array', ['a']],
      ['neq', 'an object', {}],
      ['in', 'a string', 'rds'],
      ['in', 'an object', {}],
      ['notIn', 'a number', 5],
      ['contains', 'a number', 3],
      ['contains', 'an empty string', ''],
      ['contains', 'null', null],
      ['gt', 'a string', '5'],
      ['gte', 'null', null],
      ['lt', 'a boolean', true],
      ['lte', 'an array', [1]],
    ])('for %s that is %s', (op, _what, value) => {
      expect(problems({ field: 'name', op, value })).toEqual(['definition.value']);
    });

    it('with a bad entry in a list, pointing at the entry', () => {
      expect(problems({ field: 'kind', op: 'in', value: ['a', { b: 1 }, 'c', ['d']] })).toEqual(['definition.value.1', 'definition.value.3']);
    });

    it('that is too long, or a list that is too long', () => {
      expect(problems({ field: 'name', op: 'eq', value: 'x'.repeat(RULE_LIMITS.maxStringLength + 1) })).toEqual(['definition.value']);
      expect(problems({ field: 'name', op: 'in', value: Array.from({ length: RULE_LIMITS.maxListValues + 1 }, (_, i) => `v${i}`) })).toEqual(['definition.value']);
      expect(validateRule({ field: 'name', op: 'in', value: Array.from({ length: RULE_LIMITS.maxListValues }, (_, i) => `v${i}`) }).ok).toBe(true);
    });

    it('on an operator that takes none, as an unexpected property', () => {
      expect(problems({ field: 'name', op: 'exists', value: true })).toEqual(['definition.value']);
      expect(problems({ field: 'name', op: 'notExists', value: 1 })).toEqual(['definition.value']);
      expect(messages({ field: 'name', op: 'exists', value: true })[0]).toContain('not allowed');
    });
  });

  describe('rejects unexpected properties', () => {
    it('on a field check (a typo such as "values")', () => {
      expect(problems({ field: 'kind', op: 'in', values: ['a'], value: ['a'] })).toEqual(['definition.values']);
      expect(problems({ field: 'kind', op: 'eq', value: 'a', extra: 1 })).toEqual(['definition.extra']);
    });

    it('"where" on anything but "some"', () => {
      expect(problems({ field: 'kind', op: 'eq', value: 'a', where: { field: 'x', op: 'exists' } })).toEqual(['definition.where']);
    });

    it('"value" on "some"', () => {
      expect(problems({ field: 'vulnerabilities', op: 'some', value: 1 })).toEqual(['definition.value']);
    });
  });

  describe('rejects the structure', () => {
    it.each<[string, unknown]>([
      ['null', null],
      ['a string', 'public'],
      ['a number', 3],
      ['an array', [{ field: 'kind', op: 'eq', value: 'x' }]],
      ['an empty object', {}],
    ])('when the rule is %s', (_label, raw) => {
      expect(problems(raw)).not.toEqual([]);
    });

    it.each(['all', 'any'])('an empty or non-list "%s"', (key) => {
      expect(problems({ [key]: [] })).toEqual([`definition.${key}`]);
      expect(problems({ [key]: {} })).toEqual([`definition.${key}`]);
      expect(problems({ [key]: 'x' })).toEqual([`definition.${key}`]);
    });

    it('a combinator mixed with another combinator or with a field check', () => {
      const leaf = { field: 'kind', op: 'eq', value: 'x' };
      expect(problems({ all: [leaf], any: [leaf] })).toEqual(['definition']);
      expect(problems({ all: [leaf], not: leaf })).toEqual(['definition']);
      expect(problems({ all: [leaf], field: 'kind' })).toEqual(['definition']);
      expect(problems({ not: leaf, op: 'eq' })).toEqual(['definition']);
    });

    it('too many rules in one list', () => {
      const leaf = { field: 'kind', op: 'eq', value: 'x' };

      expect(problems({ all: Array.from({ length: RULE_LIMITS.maxChildren + 1 }, () => leaf) })).toEqual(['definition.all']);
      expect(validateRule({ all: Array.from({ length: RULE_LIMITS.maxChildren }, () => leaf) }).ok).toBe(true);
    });

    it('too many rules in the whole tree', () => {
      const leaf = { field: 'kind', op: 'eq', value: 'x' };
      const group = { all: Array.from({ length: 20 }, () => leaf) };

      const result = validateRule({ all: Array.from({ length: 6 }, () => group) }); // 1 + 6 + 120 rules

      expect(result.ok).toBe(false);
      expect(messages({ all: Array.from({ length: 6 }, () => group) }).join(' ')).toContain(`more than ${RULE_LIMITS.maxRules} parts`);
    });
  });

  describe('depth', () => {
    const nest = (levels: number): unknown => {
      let rule: unknown = { field: 'kind', op: 'eq', value: 'x' };
      for (let i = 1; i < levels; i += 1) rule = { not: rule };
      return rule;
    };

    it('accepts exactly the maximum depth', () => {
      expect(validateRule(nest(RULE_LIMITS.maxDepth)).ok).toBe(true);
    });

    it('rejects one level more, with the path of the first rule that is too deep', () => {
      const result = validateRule(nest(RULE_LIMITS.maxDepth + 1));

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues).toHaveLength(1);
      expect(!result.ok && result.issues[0]!.path).toBe(`definition${'.not'.repeat(RULE_LIMITS.maxDepth)}`);
    });

    it('survives an absurdly deep rule without overflowing the stack', () => {
      const result = validateRule(nest(200_000));

      expect(result.ok).toBe(false);
    });

    it('counts "where" as a level', () => {
      let rule: unknown = { field: 'severity', op: 'eq', value: 'x' };
      for (let i = 0; i < RULE_LIMITS.maxDepth; i += 1) rule = { field: 'vulnerabilities', op: 'some', where: rule };

      expect(validateRule(rule).ok).toBe(false);
    });
  });

  describe('"where"', () => {
    it('cannot contain another "some" (vulnerabilities do not nest)', () => {
      const rule = { field: 'vulnerabilities', op: 'some', where: { field: 'metadata.list', op: 'some' } };

      expect(problems(rule)).toEqual(['definition.where.op']);
    });

    it('reports problems inside it with a path through "where"', () => {
      const rule = { field: 'vulnerabilities', op: 'some', where: { all: [{ field: 'severity', op: 'eq', value: 'a' }, { field: 'file', op: 'contains', value: 4 }] } };

      expect(problems(rule)).toEqual(['definition.where.all.1.value']);
    });

    it.each([null, 'high', 5, [], {}])('must be a rule: %p is not', (where) => {
      expect(problems({ field: 'vulnerabilities', op: 'some', where })).not.toEqual([]);
    });

    it('may be left out, or undefined', () => {
      expect(validateRule({ field: 'vulnerabilities', op: 'some', where: undefined }).ok).toBe(true);
    });
  });

  describe('reporting', () => {
    it('finds every problem at once, each with its own path', () => {
      const rule = {
        all: [
          { field: 'color', op: 'eq', value: 'x' },
          { field: 'kind', op: 'in', value: 'rds' },
          { field: 'name', op: 'bogus' },
          { not: { field: 'metadata', op: 'exists' } },
        ],
      };

      expect(problems(rule)).toEqual([
        'definition.all.0.field',
        'definition.all.1.value',
        'definition.all.2.op',
        'definition.all.3.not.field',
      ]);
    });

    it('uses the path prefix it is given', () => {
      const result = validateRule({ field: 'color', op: 'eq', value: 1 }, 'body.definition');

      expect(!result.ok && result.issues[0]!.path).toBe('body.definition.field');
    });

    it('caps the number of issues reported', () => {
      const rule = { all: Array.from({ length: 50 }, () => ({ field: 'nope', op: 'nope' })) };

      expect(problems(rule).length).toBeLessThanOrEqual(50);
    });
  });
});

describe('parseRule', () => {
  it('returns the rule when it is valid', () => {
    const rule: Rule = { field: 'kind', op: 'eq', value: 'rds' };

    expect(parseRule(rule)).toBe(rule);
  });

  it('throws a 400 INVALID_FILTER_RULE with the issues when it is not', () => {
    expect.assertions(4);
    try {
      parseRule({ field: 'color', op: 'eq', value: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).toMatchObject({ status: 400, code: 'INVALID_FILTER_RULE' });
      expect((err as ValidationError).details).toEqual([expect.objectContaining({ path: 'definition.field' })]);
      expect((err as ValidationError).message).toBe('The filter rule is not valid');
    }
  });
});
