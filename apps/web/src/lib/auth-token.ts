// Access JWT lives ONLY in module memory. Never persist to storage.
// Single source of truth for the access token; the API client reads it
// per request via configureApiAuth({ getAccessToken }).
let accessToken: string | null = null;
const listeners = new Set<(t: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
  listeners.forEach((l) => l(token));
}

export function clearAccessToken() {
  setAccessToken(null);
}

export function subscribeAccessToken(listener: (t: string | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
