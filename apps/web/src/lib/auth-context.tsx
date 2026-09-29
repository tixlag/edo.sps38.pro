import * as React from 'react';
import { getAccessToken, setAccessToken, subscribeAccessToken } from './auth-token';
import { setAuthHeader } from '@edo/api-client/src/mutator/custom-instance';

const REFRESH_URL = import.meta.env.VITE_AUTH_REFRESH_URL as string | undefined;

/**
 * Auth adapter boundary for the external unified auth service.
 * - refresh token stays in HttpOnly cookie (withCredentials),
 * - access JWT is kept in memory only,
 * - concrete refresh/login URLs come from env config.
 * TODO(auth): align request/response shape with the real auth-service contract.
 */
export function useAuthBootstrap() {
  const [status, setStatus] = React.useState<'loading' | 'ready'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (!REFRESH_URL) {
        // Dev fallback: unauthenticated demo mode so the first slice renders.
        setAccessToken('dev-demo-token');
        setAuthHeader('dev-demo-token');
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
