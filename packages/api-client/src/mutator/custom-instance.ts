import Axios, { type AxiosRequestConfig } from 'axios';

export const AXIOS_INSTANCE = Axios.create({
  baseURL: 'http://localhost:3001',
  withCredentials: true,
});

/** Called once at web bootstrap with `import.meta.env.VITE_API_BASE_URL`. */
export function setApiBaseUrl(url: string | undefined) {
  if (url) AXIOS_INSTANCE.defaults.baseURL = url;
}

// Access JWT lives ONLY in memory (see apps/web/src/lib/auth-token.ts).
// Never persist it to localStorage / sessionStorage / IndexedDB.
export function setAuthHeader(token: string | null) {
  if (token) {
    AXIOS_INSTANCE.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete AXIOS_INSTANCE.defaults.headers.common['Authorization'];
  }
}

export const customInstance = <T>(config: AxiosRequestConfig): Promise<T> => {
  return AXIOS_INSTANCE({ ...config }).then(({ data }) => data);
};
