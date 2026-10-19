import { existsSync } from 'node:fs';
import { createApp } from './app';
import { ConfigError, loadEnv } from './config/env';
import { createContainer } from './container';
import { createShutdown } from './infrastructure/graceful-shutdown';

function main(): void {
  // Locally the .env file is read here; in Docker the variables come from docker compose.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const env = loadEnv();
  const container = createContainer(env);
  const { logger } = container;
  const app = createApp(container.appDependencies);

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
  });

  const shutdown = createShutdown({ server, logger, cleanup: container.dispose });
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
}
