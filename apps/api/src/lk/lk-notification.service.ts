import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface SendLkNotificationInput {
  recipientCodes1c: string[];
  authorCode1c?: string;
  title: string;
  content: string;
  type?: "toast" | "modal";
  targetType?: string;
  targetUrl?: string;
  targetMeta?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface SendLkNotificationResult {
  success: boolean;
  broadcastUuid?: string;
  complete?: boolean;
  outcome?: "complete" | "partial" | "none";
  resolvedCodes1c?: string[];
  unresolvedCodes1c?: string[];
  code?: string;
  error?: string;
}

export interface LkUserNotificationItemDto {
  uuid: string;
  title: string;
  content: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  authorName?: string | null;
  authorAvatarUrl?: string | null;
  target?: {
    type?: string;
    url?: string;
    meta?: Record<string, unknown>;
  } | null;
}

export interface LkUserNotificationsListResponseDto {
  items: LkUserNotificationItemDto[];
  unreadCount: number;
  total: number;
}

@Injectable()
export class LkNotificationService {
  private readonly logger = new Logger(LkNotificationService.name);
  private readonly lkBaseUrl: string | null;
  private readonly internalToken: string | null;

  constructor(private readonly config: ConfigService) {
    this.lkBaseUrl = this.config.get<string>("LK_BASE_URL") ?? null;
    this.internalToken = this.config.get<string>("LK_EDO_INTERNAL_TOKEN") ?? null;
  }

  /**
   * S2S call to LK to broadcast a notification to employees by their 1C codes.
   */
  async sendNotification(input: SendLkNotificationInput): Promise<SendLkNotificationResult> {
    if (!this.lkBaseUrl || !this.internalToken) {
      this.logger.warn("LK_BASE_URL or LK_EDO_INTERNAL_TOKEN not configured. Skipping LK notification.");
      return { success: false, error: "LK integration not configured" };
    }

    if (!input.recipientCodes1c?.length) {
      return { success: false, error: "No recipients specified" };
    }

    let targetUrl = input.targetUrl;
    if (targetUrl?.startsWith("/") && !targetUrl.startsWith("//")) {
      try {
        const base = new URL(this.config.get<string>("EDO_PUBLIC_WEB_URL") ?? "");
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
            (this.config.get<string>("NODE_ENV") === "production" && base.protocol !== "https:")) throw new Error();
        targetUrl = new URL(targetUrl, base.origin).toString();
      } catch {
        this.logger.warn("EDO_PUBLIC_WEB_URL is missing or invalid; notification deferred");
        return { success: false, error: "EDO_PUBLIC_WEB_URL is missing or invalid" };
      }
    }

    const url = `${this.lkBaseUrl.replace(/\/+$/, "")}/api/internal/edo/v1/notifications`;
    const payload: Record<string, unknown> = {
      recipientCodes1c: input.recipientCodes1c,
      title: input.title,
      content: input.content,
    };
    if (input.authorCode1c) payload.authorCode1c = input.authorCode1c;
    if (input.type) payload.type = input.type;
    if (input.targetType) payload.targetType = input.targetType;
    if (targetUrl) payload.targetUrl = targetUrl;
    if (input.targetMeta) payload.targetMeta = input.targetMeta;
    if (input.idempotencyKey) payload.idempotencyKey = input.idempotencyKey;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.internalToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });

      let json: Record<string, unknown> | null = null;
      try {
        json = (await response.json()) as Record<string, unknown>;
      } catch {
        json = null;
      }

      if (response.status === 409) {
        const code = typeof json?.code === "string" ? json.code : "RECIPIENT_RESOLUTION_INCOMPLETE";
        const outcome: "complete" | "partial" | "none" =
          json?.outcome === "complete" || json?.outcome === "partial" || json?.outcome === "none"
            ? json.outcome
            : Array.isArray(json?.resolvedCodes1c) && json.resolvedCodes1c.length
              ? "partial"
              : "none";
        const resolvedCodes1c = Array.isArray(json?.resolvedCodes1c)
          ? (json.resolvedCodes1c as string[])
          : [];
        const unresolvedCodes1c = Array.isArray(json?.unresolvedCodes1c)
          ? (json.unresolvedCodes1c as string[])
          : [];
        this.logger.warn(
          `LK notification rejected with 409: ${code} (unresolved: ${unresolvedCodes1c.join(", ")})`,
        );
        return {
          success: false,
          code,
          complete: false,
          outcome,
          resolvedCodes1c,
          unresolvedCodes1c,
          error: code,
        };
      }

      if (!response.ok) {
        this.logger.error(`LK notification failed (HTTP ${response.status})`);
        const errMessage =
          typeof json?.error === "string"
            ? json.error
            : typeof json?.message === "string"
              ? json.message
              : `HTTP ${response.status}`;
        return {
          success: false,
          error: errMessage,
          code: typeof json?.code === "string" ? json.code : undefined,
        };
      }

      const complete =
        json?.complete !== undefined
          ? Boolean(json.complete)
          : json?.outcome === "complete" || (json?.success === true && json?.outcome !== "partial");
      const outcome: "complete" | "partial" | "none" =
        json?.outcome === "complete" || json?.outcome === "partial" || json?.outcome === "none"
          ? json.outcome
          : complete
            ? "complete"
            : "partial";
      const isCompleteSuccess = json?.success === true && outcome === "complete" && complete;

      if (!isCompleteSuccess) {
        const unres = Array.isArray(json?.unresolvedCodes1c)
          ? (json.unresolvedCodes1c as string[]).join(", ")
          : "none";
        this.logger.warn(
          `LK notification incomplete outcome: outcome=${outcome}, unresolved: ${unres}`,
        );
      }

      return {
        success: isCompleteSuccess,
        broadcastUuid: typeof json?.broadcastUuid === "string" ? json.broadcastUuid : undefined,
        complete,
        outcome,
        resolvedCodes1c: Array.isArray(json?.resolvedCodes1c)
          ? (json.resolvedCodes1c as string[])
          : undefined,
        unresolvedCodes1c: Array.isArray(json?.unresolvedCodes1c)
          ? (json.unresolvedCodes1c as string[])
          : undefined,
        code: typeof json?.code === "string" ? json.code : undefined,
        error: isCompleteSuccess ? undefined : "LK notification outcome is partial",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`LK notification network error: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * S2S call to LK to fetch notifications for a specific user.
   */
  async listUserNotifications(
    userUuid: string,
    limit = 20,
    offset = 0,
    status: "all" | "unread" | "read" = "all",
  ): Promise<LkUserNotificationsListResponseDto> {
    if (!this.lkBaseUrl || !this.internalToken) {
      throw new ServiceUnavailableException("LK notifications unavailable");
    }

    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      status,
    });
    const url = `${this.lkBaseUrl.replace(/\/+$/, "")}/api/internal/edo/v1/users/${userUuid}/notifications?${query.toString()}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.internalToken}`,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        this.logger.error(`Failed to fetch user notifications from LK: HTTP ${response.status}`);
        throw new ServiceUnavailableException("LK notifications unavailable");
      }

      return (await response.json()) as LkUserNotificationsListResponseDto;
    } catch (err) {
      this.logger.error(`LK list user notifications error: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException("LK notifications unavailable");
    }
  }

  /**
   * S2S call to LK to mark notifications as read.
   */
  async markRead(
    userUuid: string,
    payload: { notificationUuids?: string[]; uuids?: string[]; all?: boolean },
  ): Promise<{ updated: number }> {
    if (!this.lkBaseUrl || !this.internalToken) {
      throw new ServiceUnavailableException("LK notifications unavailable");
    }

    const url = `${this.lkBaseUrl.replace(/\/+$/, "")}/api/internal/edo/v1/users/${userUuid}/notifications/read`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.internalToken}`,
        },
        body: JSON.stringify({
          uuids: payload.uuids ?? payload.notificationUuids ?? [],
          all: Boolean(payload.all),
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new ServiceUnavailableException("LK notifications unavailable");
      }

      return (await response.json()) as { updated: number };
    } catch (err) {
      this.logger.error(`LK markRead error: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException("LK notifications unavailable");
    }
  }
}
