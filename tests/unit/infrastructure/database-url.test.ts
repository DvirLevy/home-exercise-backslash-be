import { parseDatabaseUrl } from '../../../src/infrastructure/prisma';

describe('parseDatabaseUrl', () => {
  it('returns the URL unchanged when there is no schema parameter', () => {
    expect(parseDatabaseUrl('postgresql://u:p@localhost:5432/graphs')).toEqual({
      connectionString: 'postgresql://u:p@localhost:5432/graphs',
    });
  });

  it('splits the schema parameter from the connection string', () => {
    expect(parseDatabaseUrl('postgresql://u:p@localhost:5432/graphs?schema=test')).toEqual({
      connectionString: 'postgresql://u:p@localhost:5432/graphs',
      schema: 'test',
    });
  });

  it('keeps other query parameters', () => {
    const parsed = parseDatabaseUrl('postgresql://u:p@localhost:5432/graphs?sslmode=require&schema=test');

    expect(parsed.schema).toBe('test');
    expect(parsed.connectionString).toContain('sslmode=require');
    expect(parsed.connectionString).not.toContain('schema=');
  });

  it.each(['a b', 'test;drop', '1abc', 'x-y', ''])('rejects the unsafe schema name %p', (schema) => {
    const url = `postgresql://u:p@localhost:5432/graphs?schema=${encodeURIComponent(schema)}`;

    expect(() => parseDatabaseUrl(url)).toThrow(/Invalid schema name/);
  });
});
