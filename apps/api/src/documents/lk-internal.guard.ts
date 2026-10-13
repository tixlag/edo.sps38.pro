import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "node:crypto";

@Injectable()
export class LkInternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("EDO_LK_INTERNAL_TOKEN") ?? "";
    const req = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();
    const header = req.headers.authorization;
    if (!expected || !header?.startsWith("Bearer "))
      throw new UnauthorizedException("Invalid service credential");
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(digest(header.slice(7)), digest(expected)))
      throw new UnauthorizedException("Invalid service credential");
    return true;
  }
}
