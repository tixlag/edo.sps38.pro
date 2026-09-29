import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { JwtService } from './jwt.service';
import { EDO_ACCESS_RULE_IDS } from './edo-access-rule';
import type { AccessRulesMap, AuthPrincipal } from './auth-principal';

/**
 * Verifies the unified ecosystem JWT (HS256, shared secret).
 * - Algorithm pinned to JWT_ALG (default HS256), never trusts header.alg.
 * - Issuer must equal JWT_ISSUER (default lk-auth-service); exp always checked.
 * - Fail closed: misconfiguration or invalid token -> 401.
 * - Dev bypass ONLY when ALLOW_INSECURE_DEV_AUTH=true AND NODE_ENV=development/test,
 *   accepting the literal `dev-demo-token` for local UI work. Default off.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest() as {
      headers: Record<string, string | undefined>;
      user?: AuthPrincipal;
    };
    const header = req.headers['authorization'] ?? req.headers['Authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const allowInsecure =
      String(this.config.get('ALLOW_INSECURE_DEV_AUTH') ?? process.env.ALLOW_INSECURE_DEV_AUTH ?? 'false') ===
        'true' ||
      (this.config.get('ALLOW_INSECURE_DEV_AUTH') as unknown as boolean) === true;
    const nodeEnv =
      String(this.config.get('NODE_ENV') ?? process.env.NODE_ENV ?? 'development') as string;
    if (token === 'dev-demo-token' && allowInsecure && (nodeEnv === 'development' || nodeEnv === 'test')) {
      // Local UI work only: full EDO rule set so rule-guarded slices render.
      // Never enabled in production (env validation throws when NODE_ENV=production).
      const accessRules: AccessRulesMap = {};
      for (const id of EDO_ACCESS_RULE_IDS) accessRules[String(id)] = [];
      req.user = {
        uuid: 'dev-demo',
        code1c: null,
        sid: null,
        deviceId: null,
        accessRules,
        expiresAt: null,
      };
      return true;
    }

    const principal = this.jwtService.verify(token);
    req.user = principal;
    return true;
  }
}
