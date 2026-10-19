import { ValidationError } from '../../../http/errors';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function invalidJson(message: string, reason: string): ValidationError {
  return new ValidationError(message, [{ path: 'file', message: reason }], 'INVALID_JSON');
}

/**
 * Decodes an uploaded file as UTF-8 JSON. Throws a 400 for:
 *  - invalid encoding or invalid JSON;
 *  - a NUL character (PostgreSQL cannot store it in text or JSONB);
 *  - an object key named "__proto__" at any depth. Every unknown field is preserved, but Prisma's
 *    JSON serialization silently drops that one key, so storing the file would lose data without a
 *    word. Refusing it loudly is the honest alternative (it is also a prototype-pollution vector).
 */
export function parseJsonBuffer(buffer: Buffer): unknown {
  let text: string;
  try {
    text = UTF8.decode(buffer);
  } catch {
    throw invalidJson('The file is not valid UTF-8 text', 'Invalid UTF-8');
  }
  // Editors on Windows often prepend a byte-order mark, which JSON.parse rejects.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const nulFound = invalidJson('The file contains a NUL character', 'NUL characters are not supported');
  const protoFound = invalidJson(
    'The file contains a field named "__proto__", which cannot be stored',
    'Field names called "__proto__" are not supported',
  );
  try {
    return JSON.parse(text, (key, value: unknown) => {
      if (key === '__proto__') throw protoFound;
      if (key.includes('\0') || (typeof value === 'string' && value.includes('\0'))) throw nulFound;
      return value;
    });
  } catch (err) {
    if (err === nulFound || err === protoFound) throw err;
    throw invalidJson('The file is not valid JSON', err instanceof Error ? err.message : 'Invalid JSON');
  }
}
