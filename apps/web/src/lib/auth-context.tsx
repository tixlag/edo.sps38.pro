import * as React from 'react';
import { configureApiAuth } from '@edo/api-client';
import { getAccessToken, setAccessToken, subscribeAccessToken } from './auth-token';
import { refreshAccessTokenFromCookie } from './auth-refresh';

const REFRESH_URL = import.meta.env.VITE_AUTH_REFRESH_URL as string | undefined;
// Explicit dev bypass flag (Vite). Never defaults to insecure demo mode.
const ALLOW_DEV_AUTH = import.meta.env.VITE_ALLOW_INSECURE_DEV_AUTH === 'true';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

const AuthStatusContext = React.createContext<AuthStatus>('loading');

function readDevToken(): string | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as unknown as { __EDO_DEV_TOKEN?: unknown }).__EDO_DEV_TOKEN;
  if (typeof injected === 'string' && injected) return injected;
  return 'dev-demo-token';
}

// Single-flight refresh shared by bootstrap + 401 replay (no refresh storm).
let refreshInFlight: Promise<string | null> | null = null;

async function refreshSingleFlight(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    if (!REFRESH_URL) return getAccessToken();
    const token = await refreshAccessTokenFromCookie(REFRESH_URL);
    setAccessToken(token);
    return token;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** Test-only reset for the module-level single-flight promise. */
export function __resetAuthForTests(): void {
  refreshInFlight = null;
}

/**
 * Auth adapter boundary for the external unified auth service.
 * - refresh token stays in HttpOnly cookie (withCredentials),
 * - access JWT is kept in memory only (see auth-token.ts),
 * - concrete refresh URL comes from VITE_AUTH_REFRESH_URL
 *   (default https://lk.sps38.pro/api/auth/v1/refresh-tokens, see .env.example),
 * - dev-demo-token is used ONLY when VITE_ALLOW_INSECURE_DEV_AUTH=true AND dev mode.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<AuthStatus>('loading');

  React.useEffect(() => {
    let cancelled = false;
    configureApiAuth({
      getAccessToken,
      refreshAccessToken: async () => {
        const token = await refreshSingleFlight();
        if (!cancelled) setStatus(token ? 'authenticated' : 'unauthenticated');
        return token;
      },
      onRefreshFailed: () => {
        setAccessToken(null);
        if (!cancelled) setStatus('unauthenticated');
      },
    });

    async function restore() {
      if (!REFRESH_URL) {
        if (ALLOW_DEV_AUTH && import.meta.env.DEV) {
          // E2E/dev injection: window.__EDO_DEV_TOKEN lets tests seed a real
          // signed JWT (with accessRules) without a refresh endpoint.
          // Only when the explicit dev bypass is enabled; never in production.
          const token = readDevToken();
          setAccessToken(token);
          if (!cancelled) setStatus(token ? 'authenticated' : 'unauthenticated');
        } else {
          setAccessToken(null);
          if (!cancelled) setStatus('unauthenticated');
        }
        return;
      }
      const token = await refreshSingleFlight();
      if (!cancelled) setStatus(token ? 'authenticated' : 'unauthenticated');
    }
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  return <AuthStatusContext.Provider value={status}>{children}</AuthStatusContext.Provider>;
}

export function useAuthStatus(): AuthStatus {
  return React.useContext(AuthStatusContext);
}

/** Legacy hook: prefer useAuthStatus() in new code. */
export function useAuthBootstrap(): AuthStatus {
  return useAuthStatus();
}

export function useAccessToken(): string | null {
  const [token, setToken] = React.useState<string | null>(() => getAccessToken());
  React.useEffect(() => subscribeAccessToken(setToken), []);
  return token;
}
