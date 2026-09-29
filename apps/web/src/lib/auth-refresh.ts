/**
 * Real LK auth-service refresh contract (EDO uses the versioned endpoint):
 * POST /api/auth/v1/refresh-tokens (legacy: /api/auth/refresh-tokens)
 * - refresh token is HttpOnly cookie, sent via credentials:include;
 * - request body may be empty JSON `{}`;
 * - response JSON is snake_case: { access_token, refresh_token, expires_at, ... };
 * - access JWT is ALSO returned in the `Authorization: Bearer <jwt>` header.
 *
 * EDO rules: use `access_token` (never `accessToken`), NEVER persist
 * `refresh_token` from JSON (cookie-only), access token stays in memory only.
 */

export interface LkRefreshJson {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  refresh_expires_at?: unknown;
  user_id?: unknown;
  uuid?: unknown;
  code_1c?: unknown;
  accessRules?: unknown;
}

function bearerFromHeader(headers: Headers): string | null {
  const raw = headers.get('authorization') ?? headers.get('Authorization');
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1]?.trim();
  return token ? token : null;
}

/** Pure parser (unit-testable): snake_case JSON first, Authorization header fallback. */
export function extractAccessToken(data: LkRefreshJson | null, headers: Headers): string | null {
  if (data && typeof data.access_token === 'string' && data.access_token) {
    return data.access_token;
  }
  return bearerFromHeader(headers);
}

/**
 * POST the refresh endpoint with the HttpOnly cookie.
 * Returns the new access token, or null when refresh failed.
 * 401/403 -> caller must become unauthenticated; network/5xx -> also NOT
 * authenticated (never render the protected shell as authorized).
 * Never stores or returns the refresh_token.
 */
export async function refreshAccessTokenFromCookie(
  refreshUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(refreshUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: LkRefreshJson | null = null;
  try {
    data = (await res.json()) as LkRefreshJson;
  } catch {
    data = null;
  }
  // Intentionally ignore data.refresh_token: cookie-only, never keep in JS.
  return extractAccessToken(data, res.headers);
}
