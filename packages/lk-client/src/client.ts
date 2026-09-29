import type { EdoEmployeePage, EdoLocation, EdoReference } from './generated/types';

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
 * Compact LK client (backend-only). Uses ONLY the narrow EDO spec endpoints:
 * GET /api/internal/edo/v1/{employees,locations,positions,departments}.
 * Auth: `Authorization: Bearer <LK_EDO_INTERNAL_TOKEN>` (service credential,
 * never a user JWT). Never import the full LK OpenAPI.
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
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this.getJson<EdoEmployeePage>(`/api/internal/edo/v1/employees?${params.toString()}`);
  }

  async listLocations(): Promise<EdoLocation[]> {
    return this.getJson<EdoLocation[]>('/api/internal/edo/v1/locations');
  }

  async listPositions(): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>('/api/internal/edo/v1/positions');
  }

  async listDepartments(): Promise<EdoReference[]> {
    return this.getJson<EdoReference[]>('/api/internal/edo/v1/departments');
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
