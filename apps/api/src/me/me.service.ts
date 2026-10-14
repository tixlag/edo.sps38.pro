import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthPrincipal } from '../auth/auth-principal';
import { resolveLocationScope } from '../auth/access-rules';
import type { MeResponseDto } from './dto/me-response.dto';

/**
 * "Фамилия Имя Отчество" -> "Фамилия И.О.". Single-word names pass through.
 * Returns null for empty input.
 */
export function toShortName(fullName: string | null | undefined): string | null {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const [surname, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) return surname;
  const initials = rest.map((p) => `${Array.from(p)[0]}.`).join('');
  return `${surname} ${initials}`;
}

export const AVATAR_TIMEOUT_MS = 3000;
export const AVATAR_URL_MAX_LEN = 2048;
const LK_ME_BODY_MAX_BYTES = 64 * 1024;

@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get(principal?: AuthPrincipal, userBearerToken?: string): Promise<MeResponseDto> {
    if (!principal) throw new UnauthorizedException('Missing principal');
    // Identity comes from the verified JWT. Never match people by name or create a case.
    let employee = principal.code1c
      ? await this.prisma.lkEmployee.findUnique({ where: { code1c: principal.code1c } })
      : null;
    if (!employee) {
      const matches = await this.prisma.lkEmployee.findMany({ where: { uuid: principal.uuid }, take: 2 });
      if (matches.length === 1) employee = matches[0];
    }
    // One server-side passthrough to LK GET /api/auth/me enriches BOTH the
    // avatar and the fullName fallback below. Fail-open: null body when LK is
    // unreachable, so GET /api/v1/me never breaks because of LK.
    const lkBody = await this.fetchLkMeBody(userBearerToken);
    const base = this.lkBaseUrl();
    // Primary source stays the LkEmployee projection; personalData.fio from
    // the LK response is ONLY a fallback when the projection has no row.
    const fullName = employee?.fullName ?? extractLkFullName(lkBody) ?? null;
    // JWT accessRules are the ONLY source of permissions. LK /me accessRules
    // (a different shape, service data) are deliberately never read here.
    const avatarUrl = extractAvatarUrl(lkBody, base);
    return {
      uuid: principal.uuid,
      code1c: principal.code1c,
      fullName,
      shortName: toShortName(fullName),
      avatarUrl,
      positionName: employee?.positionName ?? null,
      departmentName: employee?.departmentName ?? null,
      organizationName: employee?.organizationName ?? null,
      permissions: principal.accessRules,
      locationScope: resolveLocationScope(principal),
    };
  }

  private lkBaseUrl(): string {
    return (
      this.config.get<string>('LK_BASE_URL') ?? process.env.LK_BASE_URL ?? 'http://localhost:8080'
    );
  }

  /**
   * Server-side fetch of LK `GET /api/auth/me` with the user's own bearer
   * token. Fail-open: any failure (no token, dev bypass token, LK
   * unreachable, non-200, oversized/invalid body, redirect, timeout) resolves
   * to null and never throws. The S2S LK_EDO_INTERNAL_TOKEN is intentionally
   * NOT used here (it authenticates EDO as a service, not the user). The token
   * is never logged.
   */
  private async fetchLkMeBody(userBearerToken?: string): Promise<unknown> {
    const token = (userBearerToken ?? '').trim();
    // No token (should not happen behind JwtAuthGuard) or the dev-only bypass
    // literal: nothing to forward, stay silent and fail open.
    if (!token || token === 'dev-demo-token') return null;
    let url: URL;
    try {
      url = new URL('/api/auth/me', this.lkBaseUrl());
    } catch {
      return null;
    }
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!response.ok) return null;
      const bodyText = await response.text();
      if (Buffer.byteLength(bodyText) > LK_ME_BODY_MAX_BYTES) return null;
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        return null;
      }
    } catch (err) {
      // Fail-open by design: LK downtime must never break GET /api/v1/me.
      // Log only the error message (never the token or the raw header).
      this.logger.debug(`LK me passthrough failed (fail-open): ${(err as Error).message.slice(0, 120)}`);
      return null;
    }
  }
}

/**
 * Strict avatar extraction for LK `GET /api/auth/me`:
 *   photos.avatarUrl (priority 1) -> photos.photoUrl (priority 2).
 * `photos.photo1cUrl` is a UNC path (\\\\SDOS\\...) and is NEVER used as a URL.
 * Accepts only absolute https?:// URLs and site-relative /... paths (resolved
 * against LK_BASE_URL). UNC / empty / non-string / overlong values -> null.
 */
export function extractAvatarUrl(body: unknown, base: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const photos = (body as Record<string, unknown>)['photos'];
  if (!photos || typeof photos !== 'object') return null;
  const p = photos as Record<string, unknown>;
  for (const key of ['avatarUrl', 'photoUrl'] as const) {
    const normalized = normalizeAvatarCandidate(p[key], base);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeAvatarCandidate(raw: unknown, base: string): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > AVATAR_URL_MAX_LEN) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed.toString();
    } catch {
      return null;
    }
  }
  // Site-relative only: exactly one leading slash. Protocol-relative (//host),
  // UNC (\\...) and anything with backslashes is rejected.
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (value.includes('\\')) return null;
    try {
      return new URL(value, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Strict FIO extraction for LK `GET /api/auth/me`: personalData.fio only.
 * Used SOLELY as a fallback when the LkEmployee projection has no row.
 * Empty / non-string / missing -> null (fail-open).
 */
export function extractLkFullName(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const personalData = (body as Record<string, unknown>)['personalData'];
  if (!personalData || typeof personalData !== 'object') return null;
  const fio = (personalData as Record<string, unknown>)['fio'];
  if (typeof fio !== 'string') return null;
  const value = fio.trim();
  return value ? value : null;
}
