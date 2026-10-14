import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { Observable, type Subscriber } from "rxjs";
import type { MessageEvent } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DocumentReadService } from "./document-read.service";
import { DocumentAccessService } from "./document-access.service";
import type { AuthPrincipal } from "../auth/auth-principal";

export interface DocumentEventScope {
  chat_uuid?: string;
  code_1c?: string;
}
@Injectable()
export class DocumentStreamGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = req.headers.authorization;
    if (typeof token !== "string" || !/^Bearer [a-f0-9]{64}$/.test(token))
      throw new UnauthorizedException();
    const hash = createHash("sha256").update(token.slice(7)).digest("hex");
    const grant = await this.prisma.documentStreamGrant.findUnique({
      where: { tokenHash: hash },
    });
    if (!grant || grant.expiresAt <= new Date())
      throw new UnauthorizedException();
    req.documentScope = {
      chat_uuid: grant.chatUuid ?? undefined,
      code_1c: grant.code1c ?? undefined,
    };
    req.documentGrantExpiry = grant.expiresAt;
    return true;
  }
}
@Injectable()
export class DocumentEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentEventsService.name);
  private readonly channels = new Map<
    string,
    {
      subscribers: Set<Subscriber<MessageEvent>>;
      scope?: DocumentEventScope;
      principal?: AuthPrincipal;
      last: string;
      busy: boolean;
      retryAt: number;
      retryDelay: number;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;
  constructor(
    private readonly prisma: PrismaService,
    private readonly reads: DocumentReadService,
    private readonly access: DocumentAccessService,
    private readonly config: ConfigService,
  ) {}
  async grant(scope: DocumentEventScope) {
    this.reads.scopeWhere(scope);
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 300000);
    await this.prisma.documentStreamGrant.create({
      data: {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        chatUuid: scope.chat_uuid?.toLowerCase() ?? null,
        code1c: scope.chat_uuid ? null : (scope.code_1c ?? null),
        expiresAt,
      },
    });
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      url: `${this.config.get<string>("EDO_PUBLIC_API_URL")!.replace(/\/$/, "")}/document-status-events`,
    };
  }
  stream(
    scope?: DocumentEventScope,
    principal?: AuthPrincipal,
    expiry?: Date,
  ): Observable<MessageEvent> {
    const key = scope
      ? JSON.stringify(scope)
      : `review:${principal!.uuid}:${JSON.stringify(principal!.accessRules)}`;
    return new Observable((subscriber) => {
      let channel = this.channels.get(key);
      if (!channel) {
        channel = {
          subscribers: new Set(),
          scope,
          principal,
          last: "",
          busy: false,
          retryAt: 0,
          retryDelay: 1000,
        };
        this.channels.set(key, channel);
      }
      channel.subscribers.add(subscriber);
      if (channel.last)
        subscriber.next({ type: "documents", data: JSON.parse(channel.last) });
      void this.refresh(key);
      this.timer ??= setInterval(() => {
        this.ticks++;
        for (const name of this.channels.keys()) void this.refresh(name);
        if (this.ticks % 15 === 0)
          for (const c of this.channels.values())
            for (const s of c.subscribers)
              s.next({ type: "heartbeat", data: {} });
      }, 1000);
      this.timer.unref();
      const expires =
        expiry ??
        (principal?.expiresAt
          ? new Date(principal.expiresAt)
          : new Date(Date.now() + 300000));
      let timeout: ReturnType<typeof setTimeout>;
      const expire = () => {
        const remaining = expires.getTime() - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) {
          subscriber.complete();
          return;
        }
        // Node clamps overflowing delays to 1 ms. Long-lived JWTs need several
        // bounded waits, each checking the original expiry again.
        timeout = setTimeout(expire, Math.min(remaining, 2 ** 31 - 1));
      };
      expire();
      return () => {
        clearTimeout(timeout);
        channel!.subscribers.delete(subscriber);
        if (!channel!.subscribers.size) this.channels.delete(key);
        if (!this.channels.size) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
      };
    });
  }
  private async refresh(key: string): Promise<void> {
    const channel = this.channels.get(key);
    if (!channel || channel.busy || Date.now() < channel.retryAt) return;
    channel.busy = true;
    try {
      const result = channel.scope
        ? await this.reads.internalDocuments(channel.scope)
        : await this.reads.documents({
            ...this.access.documentWhere(channel.principal!),
            currentVersion: { gt: 0 },
          });
      const json = JSON.stringify(result);
      channel.retryAt = 0;
      channel.retryDelay = 1000;
      if (json !== channel.last) {
        channel.last = json;
        for (const s of channel.subscribers)
          s.next({ type: "documents", data: result });
      }
    } catch {
      // Headers are already 200 here. Keep SSE and its heartbeat alive while
      // retrying reads, rather than making every subscriber reconnect.
      if (!channel.retryAt)
        this.logger.warn(
          "Document status read failed; retrying within the open stream",
        );
      channel.retryAt = Date.now() + channel.retryDelay;
      channel.retryDelay = Math.min(channel.retryDelay * 2, 60000);
    } finally {
      channel.busy = false;
    }
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
    for (const c of this.channels.values())
      for (const s of c.subscribers) s.complete();
    this.channels.clear();
  }
}
