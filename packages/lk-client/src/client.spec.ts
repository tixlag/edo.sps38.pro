import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LkEdoClient } from './client';

const here = dirname(fileURLToPath(import.meta.url));

describe('lk-client (compact, backend-only)', () => {
  it('fails closed without service token', async () => {
    const client = new LkEdoClient({ baseUrl: 'http://localhost:8080', internalToken: '' });
    await expect(client.listLocations()).rejects.toThrow('LK_EDO_INTERNAL_TOKEN');
  });

  it('sends service Bearer token (never user JWT)', async () => {
    let authHeader = '';
    const client = new LkEdoClient({
      baseUrl: 'http://lk:8080',
      internalToken: 'svc-secret',
      fetchImpl: (async (url: unknown, init: unknown) => {
        authHeader = (init as { headers: Record<string, string> }).headers.Authorization;
        return { ok: true, json: async () => [] };
      }) as typeof fetch,
    });
    await client.listLocations();
    expect(authHeader).toBe('Bearer svc-secret');
  });

  it('pins the narrow EDO spec (4 paths only)', () => {
    const spec = JSON.parse(readFileSync(join(here, '..', 'openapi', 'edo.json'), 'utf8'));
    const paths = Object.keys(spec.paths);
    expect(paths.sort()).toEqual(
      [
        '/api/internal/edo/v1/departments',
        '/api/internal/edo/v1/employees',
        '/api/internal/edo/v1/locations',
        '/api/internal/edo/v1/positions',
      ].sort(),
    );
  });
});
