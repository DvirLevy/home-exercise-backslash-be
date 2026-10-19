import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Client } from 'pg';
import { TEST_SCHEMA, toTestDatabaseUrl } from './test-schema';

/**
 * Runs once before the integration tests: recreates the `test` schema and applies the real
 * migrations to it, so the tests always run against exactly what production gets.
 */
export default async function globalSetup(): Promise<void> {
  const fromFile = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const databaseUrl = process.env.DATABASE_URL ?? fromFile.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set; integration tests read it from the .env file');

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL for the integration tests (is it running? try "docker compose up -d postgres"): ${String(err)}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  execFileSync('./node_modules/.bin/prisma', ['migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: toTestDatabaseUrl(databaseUrl) },
    stdio: 'pipe',
  });
}
