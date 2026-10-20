import {
  Injectable,
  MessageEvent,
  OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";
import { Observable, Subscriber } from "rxjs";
import { z } from "zod";
import { RedisService } from "../redis/redis.module";
import { DocumentAccessService } from "../documents/document-access.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { LkChatClient } from "./lk-chat.client";

const grantSchema = z.object({
  candidateId: z.string(),
  expiresAt: z.string().datetime(),
  principal: z.object({
    uuid: z.string(),
    code1c: z.string().nullable(),
    sid: z.string().nullable(),
    deviceId: z.string().nullable(),
    accessRules: z.record(z.array(z.string())),
    expiresAt: z.string().datetime().nullable(),
  }),
});
@Injectable()
export class CommunicationEventsService implements OnModuleDestroy {
  private readonly subscriptions = new Set<Subscriber<MessageEvent>>();
  constructor(
    private readonly redis: RedisService,
    private readonly access: DocumentAccessService,
    private readonly lk: LkChatClient,
    private readonly config: ConfigService,
  ) {}
  async grant(candidateId: string, principal: AuthPrincipal) {
    await this.access.candidate(candidateId, principal);
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(
      Math.min(Date.now() + 300000, principal.expiresAt?.getTime() ?? Infinity),
    );
    if (expiresAt.getTime() <= Date.now()) throw new UnauthorizedException();
    await this.redis.setNxPxStrict(
      `edo:chat-grant:${createHash("sha256").update(token).digest("hex")}`,
      JSON.stringify({
        candidateId,
        principal,
        expiresAt: expiresAt.toISOString(),
      }),
      expiresAt.getTime() - Date.now(),
    );
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      url: `${this.config.getOrThrow<string>("EDO_PUBLIC_API_URL").replace(/\/$/, "")}/v1/communication-events`,
    };
  }
  async open(authorization?: string): Promise<Observable<MessageEvent>> {
    if (!authorization || !/^Bearer [a-f0-9]{64}$/.test(authorization))
      throw new UnauthorizedException();
    const raw = await this.redis.getStrict(
      `edo:chat-grant:${createHash("sha256").update(authorization.slice(7)).digest("hex")}`,
    );
    const parsed = grantSchema.safeParse(raw ? JSON.parse(raw) : null);
    if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now())
      throw new UnauthorizedException();
    const { candidateId, expiresAt } = parsed.data;
    const principal: AuthPrincipal = {
      ...parsed.data.principal,
      expiresAt: parsed.data.principal.expiresAt
        ? new Date(parsed.data.principal.expiresAt)
        : null,
    };
    if (!hasAccessRule(principal.accessRules, EdoAccessRule.ACCESS))
      throw new UnauthorizedException();
    await this.access.candidate(candidateId, principal);
    return new Observable((subscriber) => {
      this.subscriptions.add(subscriber);
      let stopped = false,
        busy = false,
        watchingChat: string | null = null,
        unwatch: (() => void) | undefined;
      const changed = () => {
        if (!stopped) subscriber.next({ type: "changed", data: {} });
      };
      const refresh = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
          const candidate = await this.access.candidate(candidateId, principal);
          if (stopped) return;
          if (watchingChat !== candidate.chatUuid) {
            unwatch?.();
            unwatch = undefined;
            watchingChat = candidate.chatUuid;
          }
          if (candidate.chatUuid && !unwatch && this.lk.configured())
            unwatch = this.lk.watch(candidate.chatUuid, changed, () => {
              unwatch?.();
              unwatch = undefined;
              changed();
            });
          // The generated REST read checks ERP once per tick. A notification
          // also catches late arrivals whose provider timestamp predates the
          // newest message; checking only the newest ID would miss those.
          if (candidate.erpUid) changed();
          subscriber.next({ type: "heartbeat", data: {} });
        } catch (error) {
          if (
            error instanceof Error &&
            "getStatus" in error &&
            (error as { getStatus(): number }).getStatus() === 404
          )
            subscriber.complete();
          else if (!stopped)
            subscriber.next({ type: "source-unavailable", data: {} });
        } finally {
          busy = false;
        }
      };
      void refresh();
      const timer = setInterval(() => void refresh(), 5000);
      timer.unref();
      const expiry = setTimeout(
        () => subscriber.complete(),
        Math.max(0, Date.parse(expiresAt) - Date.now()),
      );
      return () => {
        stopped = true;
        clearInterval(timer);
        clearTimeout(expiry);
        unwatch?.();
        this.subscriptions.delete(subscriber);
      };
    });
  }
  onModuleDestroy() {
    for (const subscriber of this.subscriptions) subscriber.complete();
    this.subscriptions.clear();
  }
}
