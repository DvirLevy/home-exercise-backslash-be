import pino from 'pino';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { wireApp, type Repositories } from '../../src/container';

export const silentLogger = pino({ level: 'silent' });

export const healthyDatabase: Repositories['health'] = { ping: async () => undefined };

export const failingDatabase: Repositories['health'] = {
  ping: async () => {
    throw new Error('connection refused');
  },
};

export interface TestAppOptions {
  repositories?: Partial<Repositories>;
  corsOrigins?: string[];
}

/** Builds the real app with fake repositories by default; override any repository per test. */
export function createTestApp({ repositories = {}, corsOrigins = ['http://localhost:5173'] }: TestAppOptions = {}): Express {
  return createApp(
    wireApp({
      logger: silentLogger,
      corsOrigins,
      repositories: { health: healthyDatabase, ...repositories },
    }),
  );
}
