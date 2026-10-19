import { compileNodeAccessor, compileObjectAccessor, type Accessor } from './field-resolver';
import type { FieldRule, FilterableNode, Rule, RulePrimitive } from './rule.types';

export type Predicate<T> = (subject: T) => boolean;

/**
 * "Missing" means absent or null: the database stores an unknown value as null, so both read the same.
 * Consequence: the negative operators are exact complements of their positive ones
 * (`neq` = not `eq`, `notIn` = not `in`, `notExists` = not `exists`), so a missing field satisfies them.
 * Every other operator is false for a missing field.
 */
const normalize = (value: unknown): unknown => (value === undefined ? null : value);

function compileFieldCheck<T>(rule: Exclude<FieldRule, { op: 'some' }>, accessor: Accessor<T>): Predicate<T> {
  switch (rule.op) {
    case 'eq': {
      const target = rule.value;
      return (subject) => normalize(accessor(subject)) === target;
    }
    case 'neq': {
      const target = rule.value;
      return (subject) => normalize(accessor(subject)) !== target;
    }
    case 'in': {
      const targets = new Set<RulePrimitive>(rule.value);
      return (subject) => targets.has(normalize(accessor(subject)) as RulePrimitive);
    }
    case 'notIn': {
      const targets = new Set<RulePrimitive>(rule.value);
      return (subject) => !targets.has(normalize(accessor(subject)) as RulePrimitive);
    }
    case 'exists':
      return (subject) => normalize(accessor(subject)) !== null;
    case 'notExists':
      return (subject) => normalize(accessor(subject)) === null;
    case 'contains': {
      const needle = rule.value;
      return (subject) => {
        const value = accessor(subject);
        return typeof value === 'string' && value.includes(needle);
      };
    }
    case 'gt': {
      const limit = rule.value;
      return (subject) => {
        const value = accessor(subject);
        return typeof value === 'number' && value > limit;
      };
    }
    case 'gte': {
      const limit = rule.value;
      return (subject) => {
        const value = accessor(subject);
        return typeof value === 'number' && value >= limit;
      };
    }
    case 'lt': {
      const limit = rule.value;
      return (subject) => {
        const value = accessor(subject);
        return typeof value === 'number' && value < limit;
      };
    }
    case 'lte': {
      const limit = rule.value;
      return (subject) => {
        const value = accessor(subject);
        return typeof value === 'number' && value <= limit;
      };
    }
  }
}

function compileFor<T>(rule: Rule, accessorFor: (field: string) => Accessor<T>, compileSome: (rule: Extract<FieldRule, { op: 'some' }>) => Predicate<T>): Predicate<T> {
  const recurse = (child: Rule) => compileFor(child, accessorFor, compileSome);

  if ('all' in rule) {
    const parts = rule.all.map(recurse);
    return (subject) => parts.every((part) => part(subject));
  }
  if ('any' in rule) {
    const parts = rule.any.map(recurse);
    return (subject) => parts.some((part) => part(subject));
  }
  if ('not' in rule) {
    const part = recurse(rule.not);
    return (subject) => !part(subject);
  }
  if (rule.op === 'some') return compileSome(rule);
  return compileFieldCheck(rule, accessorFor(rule.field));
}

/** Predicate over one vulnerability: field paths are resolved inside the vulnerability object. */
function compileVulnerabilityRule(rule: Rule): Predicate<unknown> {
  return compileFor<unknown>(rule, compileObjectAccessor, () => {
    throw new Error('"some" cannot be nested inside a vulnerability rule');
  });
}

/**
 * Turns a validated rule into a predicate over nodes. The predicate never throws and does not
 * mutate its input, whatever the node contains.
 */
export function compileRule(rule: Rule): Predicate<FilterableNode> {
  return compileFor<FilterableNode>(rule, compileNodeAccessor, (some) => {
    const where = some.where ? compileVulnerabilityRule(some.where) : null;
    return (node) => {
      const items = node.vulnerabilities;
      if (!Array.isArray(items)) return false;
      return where === null ? items.length > 0 : items.some((item) => where(item));
    };
  });
}
