import { useQuery } from '@tanstack/react-query';
import { getGetMeQueryOptions } from '@edo/api-client';
import { getAccessToken } from './auth-token';

/**
 * Frontend view of the current principal via GET /api/v1/me.
 * Used ONLY for UI decisions (hiding nav, labels). Backend re-checks every
 * protected action; never trust this client-side. Never touches LK directly:
 * React -> EDO API -> local MariaDB read-model.
 */
export function useMe() {
  const token = getAccessToken();
  const options = getGetMeQueryOptions({
    query: { enabled: !!token, retry: false, staleTime: 60_000 } as never,
  });
  return useQuery(options);
}
