import { ValidationError } from '../../../../src/http/errors';
import { parseJsonBuffer } from '../../../../src/modules/graphs/ingestion/upload-parser';

const buf = (text: string) => Buffer.from(text, 'utf8');

describe('parseJsonBuffer', () => {
  it('parses a JSON document', () => {
    expect(parseJsonBuffer(buf('{"nodes":[],"edges":[]}'))).toEqual({ nodes: [], edges: [] });
  });

  it('ignores a UTF-8 byte-order mark', () => {
    expect(parseJsonBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf('{"a":1}')]))).toEqual({ a: 1 });
  });

  it('keeps non-ASCII text intact', () => {
    expect(parseJsonBuffer(buf('{"name":"שירות-ü"}'))).toEqual({ name: 'שירות-ü' });
  });

  it('returns any JSON value; the schema decides whether it is a graph', () => {
    expect(parseJsonBuffer(buf('[1,2]'))).toEqual([1, 2]);
    expect(parseJsonBuffer(buf('null'))).toBeNull();
  });

  it.each([
    ['not JSON', 'hello'],
    ['truncated JSON', '{"nodes":['],
    ['an empty file', ''],
    ['trailing garbage', '{"a":1} x'],
  ])('rejects %s with INVALID_JSON', (_label, text) => {
    expect(() => parseJsonBuffer(buf(text))).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_JSON' }));
  });

  it('rejects bytes that are not valid UTF-8', () => {
    expect(() => parseJsonBuffer(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON', message: expect.stringContaining('UTF-8') }),
    );
  });

  it('includes the parser message as a detail on the "file" field', () => {
    expect.assertions(2);
    try {
      parseJsonBuffer(buf('{"a":'));
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details?.[0]?.path).toBe('file');
    }
  });

  describe('NUL characters (PostgreSQL cannot store them)', () => {
    it('rejects one inside a string value', () => {
      expect(() => parseJsonBuffer(buf('{"name":"a\\u0000b"}'))).toThrow(
        expect.objectContaining({ code: 'INVALID_JSON', message: expect.stringContaining('NUL') }),
      );
    });

    it('rejects one inside a key and inside nested data', () => {
      expect(() => parseJsonBuffer(buf('{"a\\u0000":1}'))).toThrow(/NUL/);
      expect(() => parseJsonBuffer(buf('{"x":[{"y":"\\u0000"}]}'))).toThrow(/NUL/);
    });

    it('accepts an escaped backslash followed by the text u0000', () => {
      expect(parseJsonBuffer(buf('{"a":"\\\\u0000"}'))).toEqual({ a: '\\u0000' });
    });
  });

  describe('a "__proto__" key (Prisma would silently drop it, so it is refused)', () => {
    it.each([
      ['at the top level', '{"nodes":[],"edges":[],"__proto__":{"x":1}}'],
      ['on a node', '{"nodes":[{"name":"a","kind":"s","__proto__":1}],"edges":[]}'],
      ['on an edge', '{"nodes":[],"edges":[{"from":"a","to":"b","__proto__":null}]}'],
      ['inside a vulnerability', '{"nodes":[{"name":"a","kind":"s","vulnerabilities":[{"__proto__":{}}]}],"edges":[]}'],
      ['deep inside nested data', '{"a":{"b":[{"c":{"__proto__":{"d":1}}}]}}'],
    ])('is rejected %s with a clear 400', (_label, text) => {
      expect(() => parseJsonBuffer(buf(text))).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'INVALID_JSON',
          message: expect.stringContaining('__proto__'),
        }),
      );
    });

    it('does not reject the text "__proto__" as a value, or similar-looking keys', () => {
      expect(parseJsonBuffer(buf('{"a":"__proto__","__proto":1,"proto__":2,"__PROTO__":3}'))).toEqual({
        a: '__proto__',
        __proto: 1,
        proto__: 2,
        __PROTO__: 3,
      });
    });

    it('accepts other names that are special in JavaScript', () => {
      const text = '{"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"valueOf":5}';

      expect(parseJsonBuffer(buf(text))).toEqual(JSON.parse(text));
    });
  });
});
