import type { EdoEmployeePage, EdoLocation, EdoReference } from './generated/api';
import {
  getEdoListDepartmentsUrl,
  getEdoListEmployeesUrl,
  getEdoListLocationsUrl,
  getEdoListPositionsUrl,
} from './generated/api';

export interface LkClientOptions {
  baseUrl: string;
  internalToken: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout ms (default 15000). */
  requestTimeoutMs?: number;
  /** Max transient GET retries (default 3, backoff 300ms*2^attempt, max 3s). */
  maxRetries?: number;
}

export interface LkRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
}

function requireToken(token: string): void {
  if (!token) {
    throw new Error(
      'LK_EDO_INTERNAL_TOKEN is not configured (fail closed). Set it in server env; never expose to frontend.',
    );
  }
}

export class LkContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LkContractError';
  }
}

export class LkTransientError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LkTransientError';
    this.status = status;
  }
}

export class LkAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LkAuthError';
    this.status = status;
  }
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 3;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('LK request cancelled'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const tt = t as unknown as { unref?: () => void };
    if (typeof tt.unref === 'function') tt.unref();
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('LK request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  return Math.min(300 * 2 ** attempt, 3000);
}

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

function isPermanentStatus(status: number): boolean {
  // Auth/contract errors: never retry.
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

/** Minimal runtime shape checks against the narrow contract (no PII in errors). */
function assertLocationArray(value: unknown): asserts value is EdoLocation[] {
  if (!Array.isArray(value)) throw new LkContractError('LK contract violation: locations is not an array');
  for (const [i, v] of value.entries()) {
    const r = v as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) throw new LkContractError(`LK contract violation: locations[${i}] is not an object`);
    if (typeof r['code1c'] !== 'string' || typeof r['name'] !== 'string' || typeof r['id'] !== 'number') {
      throw new LkContractError(`LK contract violation: locations[${i}] missing id/code1c/name`);
    }
    if (typeof r['deleted'] !== 'boolean') {
      throw new LkContractError(`LK contract violation: locations[${i}].deleted is not boolean`);
    }
  }
}

function assertReferenceArray(value: unknown, what: string): asserts value is EdoReference[] {
  if (!Array.isArray(value)) throw new LkContractError(`LK contract violation: ${what} is not an array`);
  for (const [i, v] of value.entries()) {
    const r = v as Record<string, unknown>;
    if (typeof r !== 'object' || r === null) throw new LkContractError(`LK contract violation: ${what}[${i}] is not an object`);
    if (typeof r['code1c'] !== 'string' || typeof r['name'] !== 'string') {
      throw new LkContractError(`LK contract violation: ${what}[${i}] missing code1c/name`);
    }
    if (typeof r['deleted'] !== 'boolean') {
      throw new LkContractError(`LK contract violation: ${what}[${i}].deleted is not boolean`);
    }
  }
}

function assertEmployeePage(value: unknown): asserts value is EdoEmployeePage {
  const r = value as Record<string, unknown>;
  if (typeof r !== 'object' || r === null) throw new LkContractError('LK contract violation: employee page is not an object');
  if (!Array.isArray(r['items'])) throw new LkContractError('LK contract violation: employee page items is not an array');
  if (!('nextCursor' in r)) {
    // Missing nextCursor is a contract error, never end-of-snapshot.
    throw new LkContractError('LK contract violation: employee page missing nextCursor (not end-of-snapshot)');
  }
  const nc = r['nextCursor'];
  if (nc !== null && typeof nc !== 'string') {
    throw new LkContractError('LK contract violation: employee page nextCursor must be string|null');
  }
  for (const [i, v] of (r['items'] as unknown[]).entries()) {
    const e = v as Record<string, unknown>;
    if (typeof e !== 'object' || e === null) throw new LkContractError(`LK contract violation: employees[${i}] is not an object`);
    if (typeof e['code1c'] !== 'string' || typeof e['uuid'] !== 'string' || typeof e['fullName'] !== 'string') {
      throw new LkContractError(`LK contract violation: employees[${i}] missing code1c/uuid/fullName`);
    }
    if (typeof e['fired'] !== 'boolean' || typeof e['contractor'] !== 'boolean') {
      throw new LkContractError(`LK contract violation: employees[${i}] fired/contractor must be boolean`);
    }
  }
}

/**
 * Compact LK client (backend-only). Types + URL helpers are GENERATED from the
 * narrow EDO spec (openapi/edo.json) via Orval; this file is the thin
 * handwritten S2S adapter that adds `Authorization: Bearer <token>` + baseUrl.
 * Never import the full LK OpenAPI. Never use from the frontend.
 *
 * Hardening (Etap 4):
 * - runtime validation of every response against the narrow contract (arrays +
 *   required fields; full zod schemas would duplicate generated types — these
 *   minimal guards catch truncation/auth-proxy HTML and missing nextCursor
 *   without hand-duplicating the whole DTO);
 * - per-request timeout + caller AbortSignal (overall deadline is enforced by
 *   the sync service; a timed-out page aborts the snapshot before markMissing);
 * - bounded retries with backoff for transient GET failures only (408/429/5xx,
 *   network errors); permanent auth/contract errors (400/401/403/404/422,
 *   LkContractError) never retry;
 * - safe error messages: status + path only, never response bodies (PII).
 */
export class LkEdoClient {
  constructor(private readonly options: LkClientOptions) {}

  private get fetchFn(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async getJson<T>(path: string, opts?: LkRequestOptions, validate?: (v: unknown) => void): Promise<T> {
    requireToken(this.options.internalToken);
    const base = this.options.baseUrl.replace(/\/$/, '');
    const timeoutMs = opts?.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts?.maxRetries ?? this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort();
      opts?.signal?.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const tt = timer as unknown as { unref?: () => void };
      if (typeof tt.unref === 'function') tt.unref();
      try {
        if (opts?.signal?.aborted) throw new Error('LK request cancelled');
        const res = await this.fetchFn(`${base}${path}`, {
          headers: { Authorization: `Bearer ${this.options.internalToken}` },
          signal: ctrl.signal,
        });
        if (!res.ok) {
          // Drain body safely but never include it in errors (PII).
          await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) {
            throw new LkAuthError(`LK request denied: ${res.status} ${path} (check LK_EDO_INTERNAL_TOKEN)`, res.status);
          }
          if (isPermanentStatus(res.status)) {
            throw new LkContractError(`LK request failed permanently: ${res.status} ${path}`);
          }
          if (isTransientStatus(res.status) && attempt < maxRetries) {
            attempt += 1;
            await sleep(backoffMs(attempt), opts?.signal);
            continue;
          }
          throw new LkTransientError(`LK request failed: ${res.status} ${path}`, res.status);
        }
        const json = (await res.json()) as unknown;
        try {
          validate?.(json);
        } catch (err) {
          // Contract violations never retry (would loop on a broken LK deploy).
          if (err instanceof LkContractError) throw err;
          throw new LkContractError(`LK contract violation: ${(err as Error).message.slice(0, 160)}`);
        }
        return json as T;
      } catch (err) {
        if (err instanceof LkAuthError || err instanceof LkContractError) throw err;
        const msg = (err as Error).message;
        if (/cancelled|aborted|Timeout|timeout/i.test(msg)) {
          // Timeout/cancellation: transient only if retries remain and caller
          // did not cancel explicitly.
          if (opts?.signal?.aborted) throw new Error('LK request cancelled');
          if (attempt < maxRetries) {
            attempt += 1;
            await sleep(backoffMs(attempt), opts?.signal);
            continue;
          }
          throw new LkTransientError(`LK request timed out: ${path}`);
        }
        // Network errors (ECONNRESET, fetch TypeError) are transient.
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(backoffMs(attempt), opts?.signal);
          continue;
        }
        if (err instanceof LkTransientError) throw err;
        throw new LkTransientError(`LK request failed: ${path} ${(msg ?? '').slice(0, 120)}`);
      } finally {
        clearTimeout(timer);
        opts?.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  async listEmployeesPage(limit: number, cursor?: string | null, opts?: LkRequestOptions): Promise<EdoEmployeePage> {
    // URL shape comes from the generated client (spec pins limit/cursor).
    const path = getEdoListEmployeesUrl({ limit, cursor: cursor ?? undefined });
    return this.getJson<EdoEmployeePage>(path, opts, assertEmployeePage);
  }

  async listLocations(opts?: LkRequestOptions): Promise<EdoLocation[]> {
    return this.getJson<EdoLocation[]>(getEdoListLocationsUrl(), opts, assertLocationArray);
  }

  async listPositions(opts?: LkRequestOptions): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>(getEdoListPositionsUrl(), opts, (v) => assertReferenceArray(v, 'positions'));
  }

  async listDepartments(opts?: LkRequestOptions): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>(getEdoListDepartmentsUrl(), opts, (v) => assertReferenceArray(v, 'departments'));
  }
}

export function createLkEdoClientFromEnv(env: {
  LK_BASE_URL?: string;
  LK_EDO_INTERNAL_TOKEN?: string;
}): LkEdoClient {
  return new LkEdoClient({
    baseUrl: env.LK_BASE_URL ?? 'http://localhost:8080',
    internalToken: env.LK_EDO_INTERNAL_TOKEN ?? '',
  });
}
