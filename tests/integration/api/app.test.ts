import request from 'supertest';
import { createTestApp } from '../../helpers/test-app';

describe('App-wide HTTP behaviour', () => {
  const app = createTestApp();

  describe('unknown routes', () => {
    it('returns 404 in the shared error format', async () => {
      const res = await request(app).get('/api/v1/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'Route GET /api/v1/does-not-exist not found' },
      });
    });
  });

  describe('request IDs', () => {
    it('generates an X-Request-Id when none is sent', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('echoes a valid incoming X-Request-Id', async () => {
      const res = await request(app).get('/health').set('X-Request-Id', 'trace-abc_123');

      expect(res.headers['x-request-id']).toBe('trace-abc_123');
    });

    it('replaces an unsafe incoming X-Request-Id', async () => {
      const res = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');

      expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('JSON bodies', () => {
    it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
      const res = await request(app)
        .post('/api/v1/anything')
        .set('Content-Type', 'application/json')
        .send('{"broken":');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });
  });

  describe('CORS', () => {
    it('allows the configured origin and exposes the API headers', async () => {
      const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');

      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(res.headers['access-control-expose-headers']).toContain('ETag');
    });

    it('does not allow other origins', async () => {
      const res = await request(app).get('/health').set('Origin', 'http://evil.test');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('API documentation', () => {
    it('serves the OpenAPI document including /health', async () => {
      const res = await request(app).get('/docs/openapi.json');

      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.paths['/health'].get).toBeDefined();
      expect(res.body.components.schemas.ErrorResponse).toBeDefined();
    });

    it('serves the Swagger UI', async () => {
      const res = await request(app).get('/docs/');

      expect(res.status).toBe(200);
      expect(res.text).toContain('swagger-ui');
    });
  });

  it('does not advertise Express', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
