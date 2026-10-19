import type { FilterableNode } from './rule.types';

export type Accessor<T> = (subject: T) => unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Follows `segments` into nested objects. Only own properties are followed, so a path such as
 * `metadata.constructor` or `extra.__proto__` can never reach something inherited.
 * Returns undefined for anything missing, including a path that runs into a non-object.
 */
export function getPath(subject: unknown, segments: readonly string[]): unknown {
  let current: unknown = subject;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Accessor for a field path inside any JSON object (used for the items of `vulnerabilities`). */
export function compileObjectAccessor(field: string): Accessor<unknown> {
  const segments = field.split('.');
  return (subject) => getPath(subject, segments);
}

/**
 * Accessor for a field path on a node: a single-valued field (`kind`), or a dotted path into
 * `metadata` / `extra` (`metadata.engine`). The path must already be validated.
 */
export function compileNodeAccessor(field: string): Accessor<FilterableNode> {
  const [head, ...rest] = field.split('.') as [string, ...string[]];
  switch (head) {
    case 'name':
      return (node) => node.name;
    case 'kind':
      return (node) => node.kind;
    case 'language':
      return (node) => node.language;
    case 'path':
      return (node) => node.path;
    case 'publicExposed':
      return (node) => node.publicExposed;
    case 'vulnerabilities':
      return (node) => node.vulnerabilities;
    case 'metadata':
      return (node) => getPath(node.metadata, rest);
    case 'extra':
      return (node) => getPath(node.extra, rest);
    default:
      throw new Error(`Unknown node field "${head}"`);
  }
}
