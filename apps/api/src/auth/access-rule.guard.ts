import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_ACCESS_RULES_KEY } from './require-access-rule.decorator';
import { EdoAccessRule } from './edo-access-rule';
import { hasAccessRule } from './access-rules';
import type { AuthPrincipal } from './auth-principal';

/**
 * Enforces @RequireAccessRule(...) after JwtAuthGuard attached req.user.
 * Passes when no rules required. Requires EDO_ACCESS (20000) implicitly? No:
 * each endpoint declares exactly what it needs; use 20000 for base access.
 */
@Injectable()
export class AccessRuleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<EdoAccessRule[]>(REQUIRED_ACCESS_RULES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const req = context.switchToHttp().getRequest() as { user?: AuthPrincipal };
    const rules = req.user?.accessRules;
    const ok = required.some((rule) => hasAccessRule(rules, rule));
    if (!ok) {
      throw new ForbiddenException('Missing required EDO access rule');
    }
    return true;
  }
}
