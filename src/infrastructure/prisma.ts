import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

export { Prisma, PrismaClient };

/** Either the root client or the client handed to an interactive transaction callback. */
export type DbClient = PrismaClient | Prisma.TransactionClient;

export interface ParsedDatabaseUrl {
  connectionString: string;
  schema?: string;
}

// The schema name ends up in a `search_path` option, so only plain identifiers are accepted.
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Splits the optional `?schema=` parameter (a Prisma convention that the pg driver does not
 * understand) from the connection string. Tests use it to run in a separate `test` schema.
 */
export function parseDatabaseUrl(databaseUrl: string): ParsedDatabaseUrl {
  const url = new URL(databaseUrl);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');

  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(`Invalid schema name in DATABASE_URL: "${schema}"`);
  }
  return schema === undefined
    ? { connectionString: url.toString() }
    : { connectionString: url.toString(), schema };
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const { connectionString, schema } = parseDatabaseUrl(databaseUrl);
  const adapter = schema
    ? // `schema` qualifies Prisma-generated queries; `search_path` makes raw SQL resolve the same way.
      new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema })
    : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
