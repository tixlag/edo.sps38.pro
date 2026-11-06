import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import WebSocket from "ws";
import { z } from "zod";
import { ChatChannel, type ChatMessageDto } from "./communications.dto";
import { CommunicationSourceError } from "./erp-communications.client";
import { MAX_CHAT_FILE_BYTES } from "./communication-contract";
import { signAttachment } from "./chat-attachment-token";

const rawMessage = z.object({
  uuid: z.string().uuid(),
  chat_uuid: z.string().uuid(),
  content: z.string().max(65536).optional(),
  created_at: z.string().datetime({ offset: true }),
  actor_user_code_1c: z.string().optional().nullable(),
  member: z
    .object({ member_type_id: z.number(), display_name: z.string().optional() })
    .optional()
    .nullable(),
  metadata: z.unknown().optional(),
});
type RawMessage = z.infer<typeof rawMessage>;
const entrySchema = z.object({ message: rawMessage.nullable().optional() });
const historyEvent = z.object({
  action: z.literal("history_chat"),
  chat: z.object({
    uuid: z.string().uuid(),
    entries: z.array(entrySchema).nullish(),
  }),
});
@Injectable()
export class LkChatClient {
  private readonly sends = new Map<string, Promise<void>>();
  constructor(private readonly config: ConfigService) {}
  configured() {
    return !!this.config.get<string>("LK_CHAT_BASE_URL");
  }
  private base() {
    const raw = this.config.get<string>("LK_CHAT_BASE_URL");
    if (!raw) throw new ServiceUnavailableException("LK_CHAT_NOT_CONFIGURED");
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new ServiceUnavailableException("LK_CHAT_NOT_CONFIGURED");
    return url;
  }
  private async socket(
    chatUuid: string,
    limit = 50,
    offset = 0,
  ) {
    const url = new URL("/ws/candidates/chat", this.base());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("chat_uuid", chatUuid);
    url.searchParams.set("candidate_flag", "false");
    url.searchParams.set("use_limit_offset", "true");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const ws = new WebSocket(url, {
      handshakeTimeout: 10000,
      maxPayload: 2 * 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
    });
    ws.on("error", () => undefined);
    return ws;
  }
  private map(candidateId: string, message: RawMessage): ChatMessageDto {
    let metadata: unknown = message.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = null;
      }
    }
    const files = Array.isArray(metadata)
      ? metadata
      : metadata
        ? [metadata]
        : [];
    const attachments = files.slice(0, 10).flatMap((raw) => {
      const file = z
        .object({
          url: z.string().max(1024),
          original_name: z.string().max(256).optional(),
          filename: z.string().max(256).optional(),
          name: z.string().max(256).optional(),
          mime: z.string().max(128).optional(),
          size_bytes: z.number().int().nonnegative().optional(),
        })
        .safeParse(raw);
      if (!file.success) return [];
      const f = file.data,
        filename = f.original_name ?? f.filename ?? f.name ?? "Вложение",
        mimeType = f.mime ?? "application/octet-stream";
      return [
        {
          id: signAttachment(this.config.getOrThrow<string>("JWT_SECRET"), {
            candidateId,
            source: "lk",
            chatUuid: message.chat_uuid,
            id: f.url,
            filename,
            mimeType,
          }),
          filename,
          mimeType,
          sizeBytes: f.size_bytes ?? null,
        },
      ];
    });
    const outgoing = message.member?.member_type_id === 4;
    return {
      id: `lk:${message.uuid}`,
      channel: ChatChannel.LK,
      outgoing,
      author:
        message.actor_user_code_1c ??
        message.member?.display_name ??
        (outgoing ? "Сотрудник" : "Кандидат"),
      createdAt: new Date(message.created_at).toISOString(),
      text: message.content ?? "",
      attachments,
    };
  }
  async history(
    candidateId: string,
    chatUuid: string,
    limit: number,
    offset: number,
  ) {
    const ws = await this.socket(chatUuid, limit, offset);
    return new Promise<{ items: ChatMessageDto[]; hasMore: boolean }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => finish(new CommunicationSourceError("LK_CHAT_TIMEOUT")),
          15000,
        );
        const finish = (
          error?: Error,
          result?: { items: ChatMessageDto[]; hasMore: boolean },
        ) => {
          clearTimeout(timer);
          ws.terminate();
          if (error) reject(error);
          else resolve(result!);
        };
        ws.once("error", () =>
          finish(new CommunicationSourceError("LK_CHAT_UNAVAILABLE")),
        );
        ws.once("close", () =>
          finish(new CommunicationSourceError("LK_CHAT_CLOSED")),
        );
        ws.on("message", (bytes) => {
          try {
            const event = historyEvent.safeParse(JSON.parse(bytes.toString()));
            if (!event.success) return;
            if (event.data.chat.uuid !== chatUuid)
              return finish(new CommunicationSourceError("LK_CHAT_CONTRACT"));
            const entries = event.data.chat.entries ?? [];
            if (
              entries.some(
                (entry) =>
                  entry.message && entry.message.chat_uuid !== chatUuid,
              )
            )
              return finish(new CommunicationSourceError("LK_CHAT_CONTRACT"));
            finish(undefined, {
              items: entries.flatMap((entry) =>
                entry.message ? [this.map(candidateId, entry.message)] : [],
              ),
              hasMore: entries.length >= limit,
            });
          } catch {
            finish(new CommunicationSourceError("LK_CHAT_CONTRACT"));
          }
        });
      },
    );
  }
  /** One upstream subscription per open screen; reconnect is owned by the SSE transport. */
  watch(
    chatUuid: string,
    changed: () => void,
    disconnected: () => void,
  ): () => void {
    let stopped = false;
    let close: (() => void) | undefined;
    void this.socket(chatUuid, 1)
      .then((ws) => {
        if (stopped) {
          ws.terminate();
          return;
        }
        ws.on("message", () => {
          if (!stopped) changed();
        });
        ws.once("close", () => {
          clearInterval(heartbeat);
          if (!stopped) disconnected();
        });
        let alive = true;
        ws.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          if (ws.readyState === WebSocket.OPEN) {
            alive = false;
            ws.ping();
          }
        }, 30000);
        heartbeat.unref();
        close = () => {
          clearInterval(heartbeat);
          ws.terminate();
        };
      })
      .catch(() => {
        if (!stopped) disconnected();
      });
    return () => {
      stopped = true;
      close?.();
    };
  }
  async sendText(chatUuid: string, actor: string, text: string, operationId: string): Promise<string> {
    // Legacy broadcasts carry no request ID. Keep this adapter's sends in order
    // so concurrent identical messages cannot consume the same echoed record.
    const previous = this.sends.get(chatUuid) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.sends.set(chatUuid, pending);
    await previous;
    try {
      return await this.sendTextOnce(chatUuid, actor, text, operationId);
    } finally {
      release();
      if (this.sends.get(chatUuid) === pending) this.sends.delete(chatUuid);
    }
  }
  private async sendTextOnce(
    chatUuid: string,
    actor: string,
    text: string,
    _operationId: string,
  ): Promise<string> {
    // Legacy chat has no request receipt. Dispatch once; never retry after uncertainty.
    const ws = await this.socket(chatUuid, 1, 0);
    return new Promise<string>((resolve, reject) => {
      const seen = new Set<string>();
      let dispatched = false,
        settled = false;
      const timer = setTimeout(
        () =>
          finish(new CommunicationSourceError("LK_CHAT_TIMEOUT", dispatched)),
        15000,
      );
      const finish = (error?: Error, id?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.terminate();
        if (error) reject(error);
        else resolve(id!);
      };
      ws.once("error", () =>
        finish(new CommunicationSourceError("LK_CHAT_UNAVAILABLE", dispatched)),
      );
      ws.once("close", () =>
        finish(new CommunicationSourceError("LK_CHAT_CLOSED", dispatched)),
      );
      ws.on("message", (bytes) => {
        try {
          const raw: unknown = JSON.parse(bytes.toString());
          const history = historyEvent.safeParse(raw);
          if (!dispatched && history.success) {
            if (history.data.chat.uuid !== chatUuid)
              return finish(new CommunicationSourceError("LK_CHAT_CONTRACT"));
            for (const entry of history.data.chat.entries ?? []) {
              if (entry.message) seen.add(entry.message.uuid);
            }
            dispatched = true;
            ws.send(
              JSON.stringify({
                event: "send_message",
                data: {
                  user_code_1c: actor,
                  chat_uuid: chatUuid,
                  message: text,
                },
              }),
            );
          } else if (dispatched) {
            const event = z.object({
              action: z.literal("new_entry"),
              chat_id: z.string().uuid(),
              entry: z.object({ message: rawMessage }),
            }).safeParse(raw);
            if (!event.success) return;
            const message = event.data.entry.message;
            if (event.data.chat_id !== chatUuid || message.chat_uuid !== chatUuid)
              return finish(new CommunicationSourceError("LK_CHAT_CONTRACT", true));
            if (!seen.has(message.uuid) && message.content === text &&
                message.actor_user_code_1c === actor && message.member?.member_type_id === 4)
              finish(undefined, message.uuid);
          }
        } catch (error) {
          finish(
            error instanceof CommunicationSourceError
              ? error
              : new CommunicationSourceError("LK_CHAT_CONTRACT", dispatched),
          );
        }
      });
    });
  }
  async sendFile(
    chatUuid: string,
    actor: string,
    text: string,
    file: { filename: string; mimeType: string; bytes: Buffer },
    _operationId: string,
  ): Promise<string> {
    const url = new URL("/chats/upload/file-message", this.base());
    url.searchParams.set("chat_uuid", chatUuid);
    url.searchParams.set("operator_1c", "true");
    url.searchParams.set("operator_code_1c", actor);
    url.searchParams.set("message", text);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.filename);
    try {
      const response = await fetch(url, {
        method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(45000),
      });
      const body = await response.text();
      if (body.length > 65536) throw new Error();
      if (!response.ok)
        throw new CommunicationSourceError(`LK_CHAT_HTTP_${response.status}`, response.status >= 500);
      const parsed = rawMessage.safeParse(JSON.parse(body));
      if (!parsed.success || parsed.data.chat_uuid !== chatUuid || parsed.data.member?.member_type_id !== 4)
        throw new CommunicationSourceError("LK_CHAT_CONTRACT", true);
      return parsed.data.uuid;
    } catch (error) {
      if (error instanceof CommunicationSourceError) throw error;
      throw new CommunicationSourceError("LK_CHAT_SEND_UNCERTAIN", true);
    }
  }
  async download(path: string): Promise<Buffer> {
    // Binaries are served by LK nginx, not by the WebSocket server on :8091.
    const base = new URL(
        this.config.get<string>("LK_PUBLIC_BASE_URL") ?? "https://lk.sps38.pro",
      ),
      url = new URL(path, base);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !/^\/(?:upload|uploads)\//.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new CommunicationSourceError("LK_CHAT_ATTACHMENT_INVALID");
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new CommunicationSourceError("LK_CHAT_ATTACHMENT_UNAVAILABLE");
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > MAX_CHAT_FILE_BYTES)
          throw new CommunicationSourceError("LK_CHAT_ATTACHMENT_TOO_LARGE");
        chunks.push(chunk);
      }
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }
}
