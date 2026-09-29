import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AXIOS_INSTANCE,
  __resetApiAuthForTests,
  configureApiAuth,
} from '@edo/api-client';

describe('api-client single-flight refresh + 401 replay', () => {
  beforeEach(() => {
    __resetApiAuthForTests();
    delete AXIOS_INSTANCE.defaults.headers.common['Authorization'];
  });

  it('sends the current in-memory token per request (no stale defaults)', async () => {
    let seenAuth = '';
    configureApiAuth({
      getAccessToken: () => 'live-token',
      refreshAccessToken: async () => 'live-token',
    });
    AXIOS_INSTANCE.defaults.adapter = async (config) => {
      seenAuth = String(config.headers?.['Authorization'] ?? '');
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };
    const res = await AXIOS_INSTANCE.get('/api/v1/me');
    expect(seenAuth).toBe('Bearer live-token');
    expect(res.data).toEqual({ ok: true });
  });

  it('concurrent 401s trigger exactly one refresh and replay once each', async () => {
    let calls = 0;
    let refreshCalls = 0;
    let current = 'old-token';
    configureApiAuth({
      getAccessToken: () => current,
      refreshAccessToken: async () => {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        current = 'new-token';
        return current;
      },
    });
    AXIOS_INSTANCE.defaults.adapter = async (config) => {
      calls += 1;
      const auth = String(config.headers?.['Authorization'] ?? '');
      if (auth === 'Bearer old-token') {
        const err = new Error('unauthorized') as Error & { response: unknown; config: unknown };
        err.config = config;
        err.response = { status: 401, data: {}, headers: {}, config };
        throw err;
      }
      return {
        data: { ok: true, auth },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };
    const [a, b] = await Promise.all([AXIOS_INSTANCE.get('/a'), AXIOS_INSTANCE.get('/b')]);
    expect(refreshCalls).toBe(1);
    expect(calls).toBe(4); // 2 initial 401 + 2 replays
    expect(a.data).toEqual({ ok: true, auth: 'Bearer new-token' });
    expect(b.data).toEqual({ ok: true, auth: 'Bearer new-token' });
  });

  it('does not retry the same request twice', async () => {
    let refreshCalls = 0;
    configureApiAuth({
      getAccessToken: () => 't',
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return 't2';
      },
    });
    AXIOS_INSTANCE.defaults.adapter = async (config) => {
      const err = new Error('unauthorized') as Error & { response: unknown; config: unknown };
      err.config = config;
      err.response = { status: 401, data: {}, headers: {}, config };
      throw err;
    };
    await expect(AXIOS_INSTANCE.get('/always-401')).rejects.toThrow();
    expect(refreshCalls).toBe(1);
  });

  it('failed refresh clears the session (onRefreshFailed)', async () => {
    const onFailed = vi.fn();
    configureApiAuth({
      getAccessToken: () => 't',
      refreshAccessToken: async () => null,
      onRefreshFailed: onFailed,
    });
    AXIOS_INSTANCE.defaults.adapter = async (config) => {
      const err = new Error('unauthorized') as Error & { response: unknown; config: unknown };
      err.config = config;
      err.response = { status: 401, data: {}, headers: {}, config };
      throw err;
    };
    await expect(AXIOS_INSTANCE.get('/x')).rejects.toThrow();
    expect(onFailed).toHaveBeenCalled();
  });
});
