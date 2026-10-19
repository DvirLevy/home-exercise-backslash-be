import { parseIfMatch, versionToEtag } from '../../../src/http/etag';

describe('versionToEtag', () => {
  it('quotes the version', () => {
    expect(versionToEtag(3)).toBe('"3"');
  });
});

describe('parseIfMatch', () => {
  it.each([
    ['3', 3],
    ['"3"', 3],
    ['W/"3"', 3],
    ['  "12"  ', 12],
  ])('reads %p as version %i', (header, version) => {
    expect(parseIfMatch(header)).toBe(version);
  });

  it('treats a missing header and "*" as no precondition', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('*')).toBeUndefined();
  });

  it.each(['abc', '""', '"0"', '-1', '1.5', '"3", "4"', '"3', '99999999999999999999', ''])(
    'rejects %p with a 400',
    (header) => {
      expect(() => parseIfMatch(header)).toThrow(
        expect.objectContaining({ status: 400, code: 'INVALID_IF_MATCH' }),
      );
    },
  );
});
