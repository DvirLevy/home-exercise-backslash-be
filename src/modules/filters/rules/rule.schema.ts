import { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../../../http/errors';
import {
  NODE_OBJECT_FIELDS,
  NODE_SCALAR_FIELDS,
  OPERATORS,
  RULE_LIMITS,
  type FieldOperator,
  type Rule,
} from './rule.types';

type Context = 'node' | 'vulnerability';

interface State {
  issues: ErrorDetail[];
  rules: number;
}

const COMBINATORS = ['all', 'any', 'not'] as const;
const MAX_REPORTED_ISSUES = 50;

const PrimitiveSchema = z.union([z.string().max(RULE_LIMITS.maxStringLength), z.number(), z.boolean(), z.null()], {
  error: 'must be a string, number, boolean or null',
});

/** The `value` each operator takes; operators without an entry take none. */
const VALUE_SCHEMAS: Partial<Record<FieldOperator, z.ZodType>> = {
  eq: PrimitiveSchema,
  neq: PrimitiveSchema,
  in: z.array(PrimitiveSchema, { error: 'must be a list' }).max(RULE_LIMITS.maxListValues),
  notIn: z.array(PrimitiveSchema, { error: 'must be a list' }).max(RULE_LIMITS.maxListValues),
  contains: z.string({ error: 'must be a string' }).min(1).max(RULE_LIMITS.maxStringLength),
  gt: z.number({ error: 'must be a number' }),
  gte: z.number({ error: 'must be a number' }),
  lt: z.number({ error: 'must be a number' }),
  lte: z.number({ error: 'must be a number' }),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function report(state: State, path: string, message: string): void {
  if (state.issues.length < MAX_REPORTED_ISSUES) state.issues.push({ path, message });
}

const join = (path: string, key: string | number): string => `${path}.${key}`;
const quote = (items: readonly string[]): string => items.map((item) => `"${item}"`).join(', ');

/** Returns a problem with a field path, or null when it is fine in this context. */
function fieldPathProblem(field: unknown, context: Context, op: FieldOperator): string | null {
  if (typeof field !== 'string' || field.length === 0) return 'must be a non-empty string';

  const segments = field.split('.');
  if (segments.length > RULE_LIMITS.maxPathSegments) {
    return `has too many segments (maximum ${RULE_LIMITS.maxPathSegments})`;
  }
  for (const segment of segments) {
    // eslint-disable-next-line no-control-regex
    if (segment.length === 0 || segment.length > RULE_LIMITS.maxSegmentLength || /[\u0000-\u001f]/.test(segment)) {
      return `has an invalid segment "${segment.slice(0, 20)}" (1-${RULE_LIMITS.maxSegmentLength} characters, no control characters)`;
    }
  }
  if (context === 'vulnerability') return null; // a vulnerability may carry any field

  const head = segments[0]!;
  if (op === 'some' && head !== 'vulnerabilities') {
    return 'the "some" operator only works on "vulnerabilities"';
  }
  if (head === 'vulnerabilities') {
    if (op !== 'some') return 'can only be used with the "some" operator';
    return segments.length === 1 ? null : 'cannot be nested';
  }
  if ((NODE_SCALAR_FIELDS as readonly string[]).includes(head)) {
    return segments.length === 1 ? null : `"${head}" holds a single value and cannot be nested`;
  }
  if ((NODE_OBJECT_FIELDS as readonly string[]).includes(head)) {
    return segments.length >= 2 ? null : `needs a key after it, e.g. "${head}.key"`;
  }
  return `is not a known field. Use ${quote([...NODE_SCALAR_FIELDS, ...NODE_OBJECT_FIELDS.map((f) => `${f}.<key>`), 'vulnerabilities'])}`;
}

function validateFieldRule(raw: Record<string, unknown>, path: string, context: Context, depth: number, state: State): void {
  const { op } = raw;
  if (typeof op !== 'string' || !(OPERATORS as readonly string[]).includes(op)) {
    report(state, join(path, 'op'), `is missing or not a known operator. Use ${quote(OPERATORS)}`);
    return;
  }
  const operator = op as FieldOperator;

  const valueSchema = VALUE_SCHEMAS[operator];
  const allowedKeys = new Set<string>(['field', 'op', ...(valueSchema ? ['value'] : operator === 'some' ? ['where'] : [])]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      report(state, join(path, key), `is not allowed for the "${operator}" operator`);
    }
  }

  if (operator === 'some' && context === 'vulnerability') {
    report(state, join(path, 'op'), 'the "some" operator is only available on a node\'s "vulnerabilities"');
    return;
  }

  const problem = fieldPathProblem(raw.field, context, operator);
  if (problem) report(state, join(path, 'field'), problem);

  if (valueSchema) {
    if (!('value' in raw)) {
      report(state, join(path, 'value'), `is required for the "${operator}" operator`);
    } else {
      const result = valueSchema.safeParse(raw.value);
      if (!result.success) {
        for (const issue of result.error.issues) {
          report(state, [join(path, 'value'), ...issue.path].join('.'), issue.message);
        }
      }
    }
  } else if (operator === 'some' && 'where' in raw && raw.where !== undefined) {
    validate(raw.where, join(path, 'where'), 'vulnerability', depth + 1, state);
  }
}

function validate(raw: unknown, path: string, context: Context, depth: number, state: State): void {
  state.rules += 1;
  if (state.rules > RULE_LIMITS.maxRules) {
    if (state.rules === RULE_LIMITS.maxRules + 1) {
      report(state, path, `the rule has more than ${RULE_LIMITS.maxRules} parts`);
    }
    return;
  }
  if (depth > RULE_LIMITS.maxDepth) {
    report(state, path, `is nested deeper than ${RULE_LIMITS.maxDepth} levels`);
    return; // never recurse past the limit, so hostile input cannot exhaust the stack
  }
  if (!isPlainObject(raw)) {
    report(state, path, 'must be an object');
    return;
  }

  const combinators = COMBINATORS.filter((key) => key in raw);
  if (combinators.length === 0) {
    validateFieldRule(raw, path, context, depth, state);
    return;
  }
  if (combinators.length > 1 || Object.keys(raw).length > 1) {
    report(state, path, 'a rule is exactly one of "all", "any", "not" or a field check, and cannot mix them');
    return;
  }

  const key = combinators[0]!;
  const child = raw[key];
  if (key === 'not') {
    validate(child, join(path, 'not'), context, depth + 1, state);
    return;
  }
  if (!Array.isArray(child) || child.length === 0) {
    report(state, join(path, key), 'must be a non-empty list of rules');
    return;
  }
  if (child.length > RULE_LIMITS.maxChildren) {
    report(state, join(path, key), `has more than ${RULE_LIMITS.maxChildren} rules`);
    return;
  }
  child.forEach((item, index) => validate(item, join(join(path, key), index), context, depth + 1, state));
}

export type RuleValidation = { ok: true; rule: Rule } | { ok: false; issues: ErrorDetail[] };

/** Checks a rule from untrusted input. Reports every problem found, with its path. */
export function validateRule(raw: unknown, basePath = 'definition'): RuleValidation {
  const state: State = { issues: [], rules: 0 };
  validate(raw, basePath, 'node', 1, state);
  return state.issues.length === 0 ? { ok: true, rule: raw as Rule } : { ok: false, issues: state.issues };
}

/** Like `validateRule`, but throws a 400 `INVALID_FILTER_RULE` carrying the issues. */
export function parseRule(raw: unknown, basePath = 'definition'): Rule {
  const result = validateRule(raw, basePath);
  if (!result.ok) {
    throw new ValidationError('The filter rule is not valid', result.issues, 'INVALID_FILTER_RULE');
  }
  return result.rule;
}
