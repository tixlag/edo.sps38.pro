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
}

function requireToken(token: string): void {
  if (!token) {
    throw new Error(
      'LK_EDO_INTERNAL_TOKEN is not configured (fail closed). Set it in server env; never expose to frontend.',
    );
  }
}

/**
 * Compact LK client (backend-only). Types + URL helpers are GENERATED from the
 * narrow EDO spec (openapi/edo.json) via Orval; this file is the thin
 * handwritten S2S adapter that adds `Authorization: Bearer <token>` + baseUrl.
 * Never import the full LK OpenAPI. Never use from the frontend.
 */
export class LkEdoClient {
  constructor(private readonly options: LkClientOptions) {}

  private get fetchFn(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async getJson<T>(path: string): Promise<T> {
    requireToken(this.options.internalToken);
    const base = this.options.baseUrl.replace(/\/$/, '');
    const res = await this.fetchFn(`${base}${path}`, {
      headers: { Authorization: `Bearer ${this.options.internalToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LK request failed: ${res.status} ${path} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async listEmployeesPage(limit: number, cursor?: string | null): Promise<EdoEmployeePage> {
    // URL shape comes from the generated client (spec pins limit/cursor).
    const path = getEdoListEmployeesUrl({ limit, cursor: cursor ?? undefined });
    return this.getJson<EdoEmployeePage>(path);
  }

  async listLocations(): Promise<EdoLocation[]> {
    return this.getJson<EdoLocation[]>(getEdoListLocationsUrl());
  }

  async listPositions(): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>(getEdoListPositionsUrl());
  }

  async listDepartments(): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>(getEdoListDepartmentsUrl());
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
