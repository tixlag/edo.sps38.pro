import * as React from 'react';
import { getAccessToken, setAccessToken, subscribeAccessToken } from './auth-token';
import { setAuthHeader } from '@edo/api-client';

const REFRESH_URL = import.meta.env.VITE_AUTH_REFRESH_URL as string | undefined;
// Explicit dev bypass flag (Vite). Never defaults to insecure demo mode.
const ALLOW_DEV_AUTH = import.meta.env.VITE_ALLOW_INSECURE_DEV_AUTH === 'true';

/**
 * Auth adapter boundary for the external unified auth service.
 * - refresh token stays in HttpOnly cookie (withCredentials),
 * - access JWT is kept in memory only (see auth-token.ts),
 * - concrete refresh/login URLs come from env config.
 * - dev-demo-token is used ONLY when VITE_ALLOW_INSECURE_DEV_AUTH=true AND dev mode.
 */
export function useAuthBootstrap() {
  const [status, setStatus] = React.useState<'loading' | 'ready'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (!REFRESH_URL) {
        if (ALLOW_DEV_AUTH && import.meta.env.DEV) {
          // E2E/dev injection: window.__EDO_DEV_TOKEN lets tests seed a real
          // signed JWT (with accessRules) without a refresh endpoint.
          // Only when the explicit dev bypass is enabled; never in production.
          const injected =
            typeof window !== 'undefined'
              ? (window as unknown as { __EDO_DEV_TOKEN?: unknown }).__EDO_DEV_TOKEN
              : null;
          const token = typeof injected === 'string' && injected ? injected : 'dev-demo-token';
          setAccessToken(token);
          setAuthHeader(token);
        } else {
          setAccessToken(null);
          setAuthHeader(null);
        }
        setStatus('ready');
        return;
      }
      try {
        const res = await fetch(REFRESH_URL, { method: 'POST', credentials: 'include' });
        if (!res.ok) throw new Error('refresh failed');
        const data = (await res.json()) as { accessToken?: string };
        if (data.accessToken) {
          setAccessToken(data.accessToken);
          setAuthHeader(data.accessToken);
        } else {
          setAccessToken(null);
          setAuthHeader(null);
        }
      } catch {
        setAccessToken(null);
        setAuthHeader(null);
      } finally {
        if (!cancelled) setStatus('ready');
      }
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}

export function useAccessToken(): string | null {
  const [token, setToken] = React.useState<string | null>(() => getAccessToken());
  React.useEffect(() => subscribeAccessToken(setToken), []);
  return token;
}
