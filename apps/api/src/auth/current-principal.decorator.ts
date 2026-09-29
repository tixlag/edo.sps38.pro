import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal } from './auth-principal';

/** Typed current-principal param decorator (populated by JwtAuthGuard). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal | undefined => {
    const req = ctx.switchToHttp().getRequest() as { user?: AuthPrincipal };
    return req.user;
  },
);
