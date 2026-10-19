import { ValidationError } from './errors';

/** Strong ETag for a graph version, e.g. `"3"`. */
export function versionToEtag(version: number): string {
  return `"${version}"`;
}

/**
 * Reads an `If-Match` header as a graph version. Accepts `3`, `"3"` and `W/"3"`.
 * `*` (any current version) and a missing header both mean "no precondition" and return undefined.
 */
export function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (value === '*') return undefined;

  const match = /^(?:W\/)?(?:"(\d+)"|(\d+))$/.exec(value);
  const version = match ? Number(match[1] ?? match[2]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ValidationError(
      'If-Match must be the graph version from its ETag, e.g. "3"',
      [{ path: 'If-Match', message: `Unsupported value: ${value.slice(0, 50)}` }],
      'INVALID_IF_MATCH',
    );
  }
  return version;
}
