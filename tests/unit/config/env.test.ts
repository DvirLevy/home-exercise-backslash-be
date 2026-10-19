import { ConfigError, loadEnv } from '../../../src/config/env';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/graphs',
};

describe('loadEnv', () => {
  it('applies defaults when only the required variables are set', () => {
    const env = loadEnv(validEnv);

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: validEnv.DATABASE_URL,
      CORS_ORIGINS: ['http://localhost:5173'],
      MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
      MAX_NODES: 50_000,
      MAX_EDGES: 500_000,
    });
  });

  it('coerces numeric strings and splits CORS origins', () => {
    const env = loadEnv({
      ...validEnv,
      PORT: '8080',
      MAX_NODES: '10',
      CORS_ORIGINS: 'http://a.test, http://b.test ,',
    });

    expect(env.PORT).toBe(8080);
    expect(env.MAX_NODES).toBe(10);
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('fails when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(ConfigError);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('fails when DATABASE_URL is not a postgres URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it.each(['abc', '0', '70000', '3.5'])('fails for invalid PORT %p', (port) => {
    expect(() => loadEnv({ ...validEnv, PORT: port })).toThrow(/PORT/);
  });

  it('fails for an unknown NODE_ENV or LOG_LEVEL', () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadEnv({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('lists every invalid variable in one error', () => {
    expect.assertions(3);
    try {
      loadEnv({ PORT: 'abc', MAX_EDGES: '-1' });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).toContain('MAX_EDGES');
    }
  });
});
