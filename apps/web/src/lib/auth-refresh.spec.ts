import { describe, expect, it } from 'vitest';
import { extractAccessToken, refreshAccessTokenFromCookie } from './auth-refresh';

function headers(auth?: string): Headers {
  const h = new Headers();
  if (auth) h.set('Authorization', auth);
  return h;
}

describe('auth refresh contract (real LK auth-service)', () => {
  it('uses snake_case access_token from JSON', () => {
    const token = extractAccessToken({ access_token: 'jwt-123' }, headers());
    expect(token).toBe('jwt-123');
  });

  it('falls back to Authorization response header', () => {
    const token = extractAccessToken({}, headers('Bearer header-jwt'));
    expect(token).toBe('header-jwt');
  });

  it('prefers JSON access_token over header', () => {
    const token = extractAccessToken({ access_token: 'json-jwt' }, headers('Bearer header-jwt'));
    expect(token).toBe('json-jwt');
  });

  it('ignores camelCase accessToken (must be snake_case)', () => {
    const token = extractAccessToken({ access_token: undefined } as never, headers());
    expect(token).toBeNull();
    const legacy = extractAccessToken({ accessToken: 'legacy' } as never, headers());
    expect(legacy).toBeNull();
  });

  it('POSTs with credentials:include and empty JSON, never persists refresh_token', async () => {
    let seen: { method?: unknown; credentials?: unknown; body?: unknown } | undefined;
    let seenUrl = '';
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seen = init as { method?: unknown; credentials?: unknown; body?: unknown };
      return {
        ok: true,
        headers: headers(),
        json: async () => ({
          access_token: 'new-jwt',
          refresh_token: 'should-stay-in-cookie',
        }),
      };
    }) as typeof fetch;
    const token = await refreshAccessTokenFromCookie('https://lk.sps38.pro/api/auth/v1/refresh-tokens', fetchImpl);
    expect(token).toBe('new-jwt');
    expect(seenUrl).toBe('https://lk.sps38.pro/api/auth/v1/refresh-tokens');
    expect(seen?.method).toBe('POST');
    expect(seen?.credentials).toBe('include');
    expect(seen?.body).toBe('{}');
    // No refresh_token leakage: only the access token is returned/stored.
    expect(token).not.toBe('should-stay-in-cookie');
  });

  it('401/403 refresh failure returns null (unauthenticated)', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, headers: headers(), json: async () => ({}) })) as unknown as typeof fetch;
    expect(await refreshAccessTokenFromCookie('https://x', fetchImpl)).toBeNull();
  });

  it('network/5xx returns null (never fake authenticated)', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await refreshAccessTokenFromCookie('https://x', failing)).toBeNull();
    const five = (async () => ({ ok: false, status: 500, headers: headers(), json: async () => ({}) })) as unknown as typeof fetch;
    expect(await refreshAccessTokenFromCookie('https://x', five)).toBeNull();
  });
});
