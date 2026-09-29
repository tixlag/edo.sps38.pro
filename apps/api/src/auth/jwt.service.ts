import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { AccessRulesMap, AuthPrincipal } from './auth-principal';

/**
 * Verifies the unified ecosystem JWT.
 * - HS256 only, algorithm pinned from EDO config (never trusts header.alg).
 * - Issuer must be `lk-auth-service` (configurable via JWT_ISSUER).
 * - exp is always verified.
 * - Fail closed: missing/invalid secret in production throws at verification time.
 */
@Injectable()
export class JwtService {
  constructor(private readonly config: ConfigService) {}

  verify(token: string): AuthPrincipal {
    const secret = this.config.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET ?? '';
    const issuer = this.config.get<string>('JWT_ISSUER') ?? process.env.JWT_ISSUER ?? 'lk-auth-service';
    const alg = this.config.get<string>('JWT_ALG') ?? process.env.JWT_ALG ?? 'HS256';
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';

    if (!secret) {
      throw new UnauthorizedException('JWT verification is not configured');
    }
    if (nodeEnv === 'production' && secret === 'dev-only-insecure-secret-change-me') {
      throw new UnauthorizedException('JWT verification is not configured');
    }
    if (alg !== 'HS256') {
      throw new UnauthorizedException('Unsupported JWT algorithm');
    }

    let decoded: unknown;
    try {
      decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        issuer,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      throw new UnauthorizedException(message);
    }

    const payload = decoded as Record<string, unknown>;
    const uuid = typeof payload['uuid'] === 'string' ? (payload['uuid'] as string) : '';
    if (!uuid) {
      throw new UnauthorizedException('JWT uuid is empty');
    }
    const code1c = typeof payload['code_1c'] === 'string' ? (payload['code_1c'] as string) : null;
    const sid = typeof payload['sid'] === 'string' ? (payload['sid'] as string) : null;
    const deviceId =
      typeof payload['device_id'] === 'string' ? (payload['device_id'] as string) : null;

    const rawRules = payload['accessRules'];
    const accessRules: AccessRulesMap = {};
    if (rawRules && typeof rawRules === 'object') {
      const entries =
        rawRules instanceof Map
          ? Array.from(rawRules.entries())
          : Object.entries(rawRules as Record<string, unknown>);
      for (const [key, value] of entries) {
        if (Array.isArray(value)) {
          accessRules[key] = value.map((v) => String(v));
        } else if (value === null || value === undefined) {
          accessRules[key] = [];
        } else {
          accessRules[key] = [String(value)];
        }
      }
    }

    const exp = payload['exp'];
    let expiresAt: Date | null = null;
    if (typeof exp === 'number') {
      expiresAt = new Date(exp * 1000);
    }

    return { uuid, code1c, sid, deviceId, accessRules, expiresAt };
  }

  /** Helper for tests: sign a token with the configured secret. */
  signForTest(payload: Record<string, unknown>): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? process.env.JWT_SECRET ?? '';
    const issuer = this.config.get<string>('JWT_ISSUER') ?? process.env.JWT_ISSUER ?? 'lk-auth-service';
    return jwt.sign({ ...payload, iss: payload['iss'] ?? issuer }, secret, {
      algorithm: 'HS256',
    });
  }
}
