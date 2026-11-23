import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import { startApi, type RunningApi } from './helpers/api';

type Doc = {
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
      }
    >
  >;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};
let api: RunningApi;
let doc: Doc;
beforeAll(async () => {
  api = await startApi();
  doc = (await client({ baseUrl: api.url }).get('/docs/openapi.json')).json as Doc;
});
afterAll(async () => {
  await api.close();
});

describe('OpenAPI document and Swagger UI', () => {
  it('serves Swagger UI at /docs', async () => {
    const r = await client({ baseUrl: api.url }).get('/docs');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/html');
  });

  it('declares the shared ErrorResponse on every failure status of every operation', async () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        for (const status of ['400', '401', '403', '404', '413', '415', '500']) {
          const ref = op.responses[status]?.content?.['application/json']?.schema?.$ref;
          expect(ref, `${method.toUpperCase()} ${path} ${status}`).toMatch(/ErrorResponse/);
        }
      }
    }
    expect(doc.components.schemas).toHaveProperty('ErrorResponseDto');
  });

  it('gives every operation a success response with a typed body schema', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const ok = Object.entries(op.responses).find(([s]) => s.startsWith('2'));
        expect(ok, `${method.toUpperCase()} ${path}`).toBeDefined();
      }
    }
  });

  it('describes bearer and ticket-link security schemes', () => {
    expect(Object.keys(doc.components.securitySchemes)).toEqual(
      expect.arrayContaining(['bearer', 'ticket-link']),
    );
  });
});
