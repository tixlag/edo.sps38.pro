import Axios, { type AxiosRequestConfig } from 'axios';

export const AXIOS_INSTANCE = Axios.create({
  baseURL: 'http://localhost:3001',
  withCredentials: true,
});

/** Called once at web bootstrap with `import.meta.env.VITE_API_BASE_URL`. */
export function setApiBaseUrl(url: string | undefined) {
  if (url) AXIOS_INSTANCE.defaults.baseURL = url;
}

export interface ApiAuthAdapter {
  /** Return the current in-memory access JWT (single source of truth lives in web). */
  getAccessToken: () => string | null;
  /**
   * Refresh the access token via the LK auth refresh endpoint (HttpOnly cookie).
   * Must update the in-memory store itself and return the new token, or null
   * when refresh failed (401/403). Implementations must be single-flight
   * internally as well; the client additionally dedups concurrent 401s.
   */
  refreshAccessToken: () => Promise<string | null>;
  /** Called when refresh failed and the session must become unauthenticated. */
  onRefreshFailed?: () => void;
}

let authAdapter: ApiAuthAdapter | null = null;
// Shared single-flight refresh promise for concurrent 401s.
let refreshPromise: Promise<string | null> | null = null;

interface RetriableConfig extends AxiosRequestConfig {
  __edoRetried?: boolean;
  __skipAuthRefresh?: boolean;
}

/**
 * Wire the in-memory token store without importing apps/web code.
 * The client reads the current token per request (no persistent
 * defaults.headers as the primary mechanism) and replays 401s once.
 */
export function configureApiAuth(adapter: ApiAuthAdapter): void {
  authAdapter = adapter;
}

/** Test-only reset (clears adapter + single-flight state). */
export function __resetApiAuthForTests(): void {
  authAdapter = null;
  refreshPromise = null;
}

// Access JWT lives ONLY in memory (see apps/web/src/lib/auth-token.ts).
// Never persist it to localStorage / sessionStorage / IndexedDB.
// Legacy helper kept for compat: per-request interceptor is the primary
// mechanism now; this only mirrors the value into defaults for tooling.
export function setAuthHeader(token: string | null) {
  if (token) {
    AXIOS_INSTANCE.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete AXIOS_INSTANCE.defaults.headers.common['Authorization'];
  }
}

AXIOS_INSTANCE.interceptors.request.use((config) => {
  try {
    const token = authAdapter?.getAccessToken?.() ?? null;
    if (token) {
      config.headers = config.headers ?? {};
      (config.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }
  } catch {
    // getAccessToken must never break the request path
  }
  return config;
});

AXIOS_INSTANCE.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error?.config as RetriableConfig | undefined;
    if (!original || !error?.response) return Promise.reject(error);
    if (error.response.status !== 401) return Promise.reject(error);
    if (original.__edoRetried || original.__skipAuthRefresh) return Promise.reject(error);
    if (!authAdapter) return Promise.reject(error);
    original.__edoRetried = true;
    try {
      if (!refreshPromise) {
        const p = authAdapter.refreshAccessToken();
        refreshPromise = p;
        // Clear after settlement so the next 401 starts a fresh cycle.
        void p.then(
          () => {
            refreshPromise = null;
          },
          () => {
            refreshPromise = null;
          },
        );
      }
      const newToken = await refreshPromise;
      if (!newToken) {
        try {
          authAdapter.onRefreshFailed?.();
        } catch {
          // ignore
        }
        return Promise.reject(error);
      }
      original.headers = original.headers ?? {};
      (original.headers as Record<string, string>)['Authorization'] = `Bearer ${newToken}`;
      return AXIOS_INSTANCE(original);
    } catch {
      try {
        authAdapter?.onRefreshFailed?.();
      } catch {
        // ignore
      }
      return Promise.reject(error);
    }
  },
);

export const customInstance = <T>(config: AxiosRequestConfig): Promise<T> => {
  return AXIOS_INSTANCE({ ...config }).then(({ data }) => data);
};
