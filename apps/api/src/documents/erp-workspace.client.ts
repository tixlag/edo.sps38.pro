import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";

const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const named = z.object({ code: z.string(), name: z.string() });
export const erpIdentitySchema = z
  .object({
    recipientType: z.enum(["candidate", "person"]),
    reviewGroup: z.enum(["RU", "IG"]),
    erpUid: uuid.nullable(),
    chatUuid: uuid.nullable(),
    personUid: uuid.nullable(),
    code1C: z.string(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.reviewGroup === "RU" &&
        (v.recipientType !== "candidate" || !v.erpUid)) ||
      (v.reviewGroup === "IG" &&
        (v.recipientType !== "person" ||
          !v.personUid ||
          v.erpUid ||
          v.chatUuid))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid business recipient",
      });
  });
export type ErpIdentity = z.infer<typeof erpIdentitySchema>;
export const erpCardSchema = z.object({
  erpUid: uuid,
  chatUuid: uuid.nullable(),
  code1C: z.string().nullable(),
  personUid: uuid.nullable(),
  reviewGroup: z.literal("RU"),
  fullName: z.string(),
  phone: z.string(),
  birthDate: z.string(),
  citizenship: z.string().regex(/^[a-zA-Z]{2}$/),
  position: named.nullable(),
  project: named.nullable(),
  manager: z.object({ id: z.string(), name: z.string() }).nullable(),
  mentor: z
    .object({ name: z.string(), position: z.string().optional() })
    .passthrough()
    .nullable(),
  status: z.object({ id: z.string(), name: z.string() }).nullable(),
  history: z.array(
    z.object({
      date: z.string(),
      author: z.string(),
      statusId: z.string(),
      statusName: z.string(),
      comment: z.string(),
    }),
  ),
});
export type ErpCard = z.infer<typeof erpCardSchema>;
export const previousDocumentsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().max(256),
      documentUid: uuid.nullable(),
      title: z.string().max(512),
      fields: z.record(z.unknown()),
      expiresAt: z.string().nullable(),
      originalAvailable: z.boolean(),
      recheckStatus: z.enum(["REQUIRES_REVIEW", "ORIGINAL_UNAVAILABLE"]),
    }),
  ),
});
export const referencesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      code: z.string().optional(),
      birthDate: z.string().nullable().optional(),
      editable: z.boolean().optional(),
      requiresProject: z.boolean().optional(),
      requiresPlannedArrivalDate: z.boolean().optional(),
    }),
  ),
});

/** Shared narrow ERP business bridge. No automatic retries of mutations. */
@Injectable()
export class ErpWorkspaceClient {
  constructor(private readonly config: ConfigService) {}
  private async response(
    action: string,
    query: Record<string, string>,
    body?: unknown,
  ) {
    const endpoint = this.config.get<string>("ERP_COMMUNICATIONS_URL"),
      token = this.config.get<string>("ERP_CANDIDATE_TOKEN"),
      username = this.config.get<string>("ERP_USERNAME"),
      password = this.config.get<string>("ERP_PASSWORD");
    if (!endpoint || !token || !username || !password)
      throw new ServiceUnavailableException("ERP_WORKSPACE_NOT_CONFIGURED");
    let url: URL;
    try {
      url = new URL(endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException("ERP_WORKSPACE_NOT_CONFIGURED");
    }
    url.searchParams.set("action", action);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(body === undefined ? 15000 : 45000),
      });
    } catch {
      throw new ServiceUnavailableException(
        body === undefined ? "ERP_UNAVAILABLE" : "ERP_OPERATION_RESULT_UNKNOWN",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409)
        throw new ConflictException(
          "ERP_RELATION_OR_OPERATION_CONFLICT: требуется точечная проверка связи или результата операции в ERP",
        );
      if (response.status === 404)
        throw new NotFoundException("ERP_ENTITY_NOT_FOUND");
      throw new ServiceUnavailableException(
        body === undefined ? "ERP_UNAVAILABLE" : "ERP_OPERATION_RESULT_UNKNOWN",
      );
    }
    return response;
  }
  async request<T>(
    action: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const response = await this.response(action, query, body);
    const bytes = await this.readBounded(response, 2 * 1024 * 1024);
    try {
      return schema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new ServiceUnavailableException("ERP_WORKSPACE_CONTRACT_ERROR");
    }
  }
  private async readBounded(response: Response, limit: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    if (!response.body)
      throw new ServiceUnavailableException("ERP_WORKSPACE_CONTRACT_ERROR");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > limit)
          throw new ServiceUnavailableException(
            "ERP_WORKSPACE_RESPONSE_TOO_LARGE",
          );
        chunks.push(Buffer.from(r.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }
  async identity(code1c: string) {
    const identity = await this.request("identity", erpIdentitySchema, {
      code1c,
    });
    if (identity.code1C !== code1c)
      throw new ConflictException("ERP_IDENTITY_MISMATCH");
    return identity;
  }
  card(erpUid: string) {
    return this.request("card", erpCardSchema, { candidate: erpUid });
  }
  async original(erpUid: string, id: string) {
    const response = await this.response("person-document-original", {
      candidate: erpUid,
      id,
    });
    return {
      bytes: await this.readBounded(response, 100 * 1024 * 1024),
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}
