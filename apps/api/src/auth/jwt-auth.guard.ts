import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Abstraction over the external unified auth service.
 *
 * Real JWT verification (issuer/JWKS/audience from env) is plugged here once
 * the auth-service contract is provided. For the first slice the guard:
 * - allows @Public() routes (health, openapi),
 * - accepts any well-formed `Authorization: Bearer <jwt>` on protected routes
 *   so the end-to-end chain can be proven without inventing the IdP contract.
 *
 * TODO(auth): verify signature via AUTH_JWKS_URL / AUTH_ISSUER / AUTH_AUDIENCE.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest() as {
      headers: Record<string, string | undefined>;
      user?: unknown;
    };
    const header = req.headers['authorization'] ?? req.headers['Authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length).trim();
    if (token.split('.').length !== 3 && token.length < 8) {
      throw new UnauthorizedException('Malformed bearer token');
    }
    // Attach a minimal principal; real claims come from verified JWT later.
    req.user = { token };
    return true;
  }
}
