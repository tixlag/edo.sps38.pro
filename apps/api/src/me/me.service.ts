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

const AVATAR_TIMEOUT_MS = 3000;
const AVATAR_URL_MAX_LEN = 2048;

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
    const fullName = employee?.fullName ?? null;
    // The LkEmployee projection has no avatar column and the narrow LK->EDO
    // master-data contract (packages/lk-client/openapi/edo.json) exposes no
    // avatar field, so avatarUrl can only come from a server-side passthrough
    // to LK with the user's own JWT (never the S2S token). Fail-open: null
    // when LK is unreachable. TODO: persist avatarUrl in the projection once
    // the LK contract exposes it (blocked, see
    // docs/integrations/edo-lk-contract-status.md); do not invent revisions.
    const avatarUrl = await this.resolveAvatarUrl(userBearerToken);
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

  /**
   * Server-side enrichment of the user avatar from LK `GET /api/auth/me`,
   * forwarding the user's own bearer token. Fail-open: any failure (no token,
   * dev bypass token, LK unreachable, non-200, unexpected shape) resolves to
   * null and never throws. The S2S LK_EDO_INTERNAL_TOKEN is intentionally NOT
   * used here (it authenticates EDO as a service, not the user). The token is
   * never logged.
   */
  private async resolveAvatarUrl(userBearerToken?: string): Promise<string | null> {
    const token = (userBearerToken ?? '').trim();
    // No token (should not happen behind JwtAuthGuard) or the dev-only bypass
    // literal: nothing to forward, stay silent and fail open.
    if (!token || token === 'dev-demo-token') return null;
    const base =
      this.config.get<string>('LK_BASE_URL') ?? process.env.LK_BASE_URL ?? 'http://localhost:8080';
    let url: URL;
    try {
      url = new URL('/api/auth/me', base);
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
      if (Buffer.byteLength(bodyText) > 64 * 1024) return null;
      let body: unknown;
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        return null;
      }
      return extractAvatarUrl(body, base);
    } catch (err) {
      // Fail-open by design: LK downtime must never break GET /api/v1/me.
      this.logger.debug(`LK avatar passthrough failed (fail-open): ${(err as Error).message.slice(0, 120)}`);
      return null;
    }
  }
}

/** Pick a plausible avatar field from the LK /api/auth/me payload. Unknown shapes -> null. */
function extractAvatarUrl(body: unknown, base: string): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  // LK response shape is not part of the narrow EDO contract; accept the
  // common key variants, checking the nested `user` object as well.
  const nested = obj['user'] && typeof obj['user'] === 'object' ? (obj['user'] as Record<string, unknown>) : null;
  const candidates = [
    obj['avatarUrl'],
    obj['avatar_url'],
    obj['photoUrl'],
    obj['photo_url'],
    obj['photo'],
    obj['avatar'],
    nested?.['avatarUrl'],
    nested?.['avatar_url'],
    nested?.['photoUrl'],
    nested?.['photo'],
    nested?.['avatar'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (!value || value.length > AVATAR_URL_MAX_LEN) continue;
    // Accept absolute http(s) URLs and site-relative paths only.
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) {
      try {
        return new URL(value, base).toString();
      } catch {
        continue;
      }
    }
  }
  return null;
}
