/** Integration tests run in this schema of the same database, so development data is never touched. */
export const TEST_SCHEMA = 'test';

export function toTestDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', TEST_SCHEMA);
  return url.toString();
}
