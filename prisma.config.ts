import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env on its own. Inside Docker there is no .env file;
// the variables come from docker compose instead.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Optional so that `prisma generate` works without a database (e.g. during the Docker build).
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
