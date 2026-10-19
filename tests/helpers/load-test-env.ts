import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Tests read connection details from the single .env file. process.loadEnvFile() would write to
// the real process, not Jest's sandboxed process.env, so values are assigned explicitly.
// Variables already set in the environment win, matching Node's own .env behaviour.
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    process.env[key] ??= value;
  }
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
