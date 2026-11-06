import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "node:crypto";

export const ADAPTATION_ACCESS_TOKEN_HEADER = "x-adaptation-token";

@Injectable()
export class ErpAdaptationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected =
      this.config.get<string>("EDO_ERP_ADAPTATION_TOKEN")?.trim() ||
      "";

    if (!expected) {
      throw new UnauthorizedException("Invalid service credential");
    }

    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();

    let received = "";
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      received = authHeader.slice(7).trim();
    } else {
      const customHeader = req.headers[ADAPTATION_ACCESS_TOKEN_HEADER];
      if (typeof customHeader === "string") {
        received = customHeader.trim();
      } else if (Array.isArray(customHeader) && customHeader.length > 0) {
        received = customHeader[0].trim();
      }
    }

    if (!received) {
      throw new UnauthorizedException("Invalid service credential");
    }

    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (!timingSafeEqual(digest(received), digest(expected))) {
      throw new UnauthorizedException("Invalid service credential");
    }

    return true;
  }
}
