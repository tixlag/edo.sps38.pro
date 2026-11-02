import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import {
  erpCatalogSchema,
  erpContextSchema,
  erpHistorySchema,
  erpSendResultSchema,
  MAX_CHAT_FILE_BYTES,
} from "./communication-contract";

export class CommunicationSourceError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
  ) {
    super(code);
  }
}

/** Narrow backend-only bridge. Provider credentials, file URLs and bodies never enter errors. */
@Injectable()
export class ErpCommunicationsClient {
  constructor(private readonly config: ConfigService) {}
  configured() {
    return !!this.config.get<string>("ERP_COMMUNICATIONS_URL");
  }

  private async request<T>(
    action: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const endpoint = this.config.get<string>("ERP_COMMUNICATIONS_URL");
    const token = this.config.get<string>("ERP_CANDIDATE_TOKEN");
    const username = this.config.get<string>("ERP_USERNAME");
    const password = this.config.get<string>("ERP_PASSWORD");
    if (!endpoint || !token || !username || !password)
      throw new ServiceUnavailableException(
        "ERP_COMMUNICATIONS_NOT_CONFIGURED",
      );
    let url: URL;
    try {
      url = new URL(endpoint);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException(
        "ERP_COMMUNICATIONS_NOT_CONFIGURED",
      );
    }
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          token,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(body === undefined ? 15000 : 45000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CommunicationSourceError(
          `ERP_CHAT_HTTP_${response.status}`,
          body !== undefined && response.status >= 500,
        );
      }
      const max = action === "attachment" ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
      if (Number(response.headers.get("content-length") ?? 0) > max) {
        await response.body?.cancel();
        throw new CommunicationSourceError(
          "ERP_CHAT_CONTRACT",
          body !== undefined,
        );
      }
      let length = 0;
      const chunks: Uint8Array[] = [];
      if (!response.body)
        throw new CommunicationSourceError(
          "ERP_CHAT_CONTRACT",
          body !== undefined,
        );
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > max)
            throw new CommunicationSourceError(
              "ERP_CHAT_CONTRACT",
              body !== undefined,
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const result = schema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!result.success)
        throw new CommunicationSourceError(
          "ERP_CHAT_CONTRACT",
          body !== undefined,
        );
      return result.data;
    } catch (error) {
      if (error instanceof CommunicationSourceError) throw error;
      throw new CommunicationSourceError(
        "ERP_CHAT_UNAVAILABLE",
        body !== undefined,
      );
    }
  }
  catalog(cursor?: string) {
    return this.request(
      "candidates",
      erpCatalogSchema,
      cursor ? { cursor } : {},
    );
  }
  context(erpUid: string, actorCode1c?: string) {
    return this.request("context", erpContextSchema, {
      candidate: erpUid,
      ...(actorCode1c ? { actor: actorCode1c } : {}),
    });
  }
  history(erpUid: string, limit: number, cursor?: string) {
    return this.request("history", erpHistorySchema, {
      candidate: erpUid,
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
  }
  send(body: {
    candidate: string;
    actor: string;
    requestId: string;
    channel: string;
    recipientId: string;
    text: string;
    file?: { filename: string; mimeType: string; base64: string };
  }) {
    return this.request("send", erpSendResultSchema, {}, body);
  }
  link(erpUid: string, actor: string) {
    return this.request(
      "link",
      z.object({ chatUuid: z.string().uuid(), url: z.string().url() }),
      {},
      { candidate: erpUid, actor },
    );
  }
  async attachment(erpUid: string, id: string) {
    const file = await this.request(
      "attachment",
      z.object({
        filename: z.string().max(256),
        mimeType: z.string().max(128),
        base64: z.string().max(14 * 1024 * 1024),
      }),
      { candidate: erpUid, id },
    );
    const bytes = Buffer.from(file.base64, "base64");
    if (
      !bytes.length ||
      bytes.length > MAX_CHAT_FILE_BYTES ||
      bytes.toString("base64") !== file.base64
    )
      throw new CommunicationSourceError("ERP_CHAT_CONTRACT");
    return { filename: file.filename, mimeType: file.mimeType, bytes };
  }
}
