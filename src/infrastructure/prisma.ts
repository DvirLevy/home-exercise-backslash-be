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

/**
 * Builds a NEW client with its own connection pool. Application code must not call this: use
 * `getPrismaClient`. It is exported for tests, which need separate clients for separate schemas.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const { connectionString, schema } = parseDatabaseUrl(databaseUrl);
  const adapter = schema
    ? // `schema` qualifies Prisma-generated queries; `search_path` makes raw SQL resolve the same way.
      new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema })
    : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

let singleton: { client: PrismaClient; databaseUrl: string } | undefined;

/**
 * The one PrismaClient of this process. Every repository shares it, so the whole application uses a
 * single connection pool. The first call creates it; later calls return the same instance.
 *
 * @throws if a client already exists for a different DATABASE_URL: a process has one database.
 */
export function getPrismaClient(databaseUrl: string): PrismaClient {
  if (singleton) {
    if (singleton.databaseUrl !== databaseUrl) {
      throw new Error('A PrismaClient already exists for a different DATABASE_URL; one process uses one database');
    }
    return singleton.client;
  }
  singleton = { client: createPrismaClient(databaseUrl), databaseUrl };
  return singleton.client;
}

/** Closes the shared client and forgets it, so a later `getPrismaClient` starts fresh. Safe to call twice. */
export async function disconnectPrisma(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.client.$disconnect();
}
