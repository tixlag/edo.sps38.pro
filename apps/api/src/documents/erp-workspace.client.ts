import { arrivalPageSchema } from "./ig-arrival-contract";
import { arrivalFactsPageSchema } from "./ig-arrival-facts-contract";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import type { ReadableStreamReadResult } from "node:stream/web";

const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const named = z.object({ code: z.string(), name: z.string() });
const safeConflictCodes = new Set([
  "CANDIDATE_DUPLICATE_REQUIRES_REVIEW",
  "EXISTING_PERSON_REQUIRES_EXPLICIT_SELECTION",
  "CANDIDATE_PERSON_LINK_AMBIGUOUS",
  "PERSON_IDENTITY_AMBIGUOUS",
  "CURRENT_CANDIDATE_AMBIGUOUS",
  "CURRENT_CANDIDATE_CONFIRMATION_REQUIRED",
  "CURRENT_CANDIDATE_UNAVAILABLE",
  "CANDIDATE_PERSON_LINK_CONFLICT",
  "PERSON_LINK_REQUIRED_OR_AMBIGUOUS",
  "DISPATCHER_NOT_CONFIGURED",
  "DISPATCHER_EMAIL_NOT_CONFIGURED",
  "OPERATION_RESULT_UNKNOWN",
  "IDEMPOTENCY_CONFLICT",
]);
const safeForbiddenCodes = new Set([
  "ACTOR_NOT_FOUND_OR_AMBIGUOUS",
  "STATUS_OWNED_BY_DISPATCH_OR_HR",
]);
const safeBadRequestCodes = new Set([
  "REFERENCE_NOT_FOUND",
  "INVALID_FULL_NAME",
  "CONTACT_KIND_NOT_FOUND",
  "CONTACT_KIND_TYPE_MISMATCH",
  "INVALID_CODE",
  "INVALID_CONTACT_COMMENT",
  "INVALID_CONTACT_PRESENTATION",
  "INVALID_CONTACT_ROW",
  "INVALID_CONTACTS",
  "INVALID_CONTACT_TYPE",
  "INVALID_EXPECTED_INCOME",
  "INVALID_IGNORED_DUPLICATES",
  "INVALID_INTERNSHIP_DATE",
  "INVALID_INTERNSHIP_DATE_RANGE",
  "INVALID_PERSON_MATCH_NAME",
  "INVALID_RESPONSIBLE",
  "INVALID_SEARCH",
  "INVALID_SETTLEMENT",
  "INVALID_SEX",
  "INVALID_SOURCE",
  "INVALID_SOURCE_COMMENT",
  "MISSING_CANDIDATE",
  "PERSON_MATCH_NAME_REQUIRED",
  "PERSON_NOT_FOUND",
  "PERSON_REQUIRED",
  "READONLY_OR_UNKNOWN_FIELD",
  "RESPONSIBLE_NOT_FOUND",
  "SEARCH_TOO_SHORT",
  "UNKNOWN_FIELD",
  "INVALID_CURSOR",
  "POSITION_NOT_FOUND_OR_AMBIGUOUS",
  "COUNTRY_NOT_FOUND",
  "MANAGER_NOT_FOUND",
  "PROJECT_NOT_FOUND_OR_AMBIGUOUS",
  "PROJECT_UNAVAILABLE",
  "INVALID_PHONE",
  "FULL_NAME_TOO_LONG",
  "INVALID_BIRTH_DATE",
  "INVALID_FIELDS",
  "REQUIRED_FIELD_MISSING",
  "INVALID_FIELD",
  "INVALID_STATUS",
  "INVALID_COMMENT",
  "ARRIVAL_PROJECT_AND_DATE_REQUIRED",
  "INVALID_ARRIVAL_PROJECT_OR_DATE",
  "ARRIVAL_PROJECT_OR_DATE_UNAVAILABLE",
  "TARGET_REQUIRED",
  "EMPTY_BODY",
  "MISSING_IDENTITY",
  "INVALID_REQUEST_ID",
]);
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
  birthDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  citizenship: z
    .string()
    .regex(/^[a-zA-Z]{2}$/)
    .nullable(),
  position: named.nullable(),
  project: named.nullable(),
  manager: z.object({ id: z.string(), name: z.string() }).nullable(),
  mentor: z
    .object({ name: z.string(), position: z.string().optional() })
    .passthrough()
    .nullable(),
  status: z.object({ id: z.string(), name: z.string() }).nullable(),
  person: z
    .object({
      id: uuid,
      name: z.string(),
      birthDate: z.string().nullable(),
      code: z.string().optional(),
    })
    .nullable()
    .default(null),
  sex: z.enum(["male", "female"]).nullable().default(null),
  settlement: z.string().max(500).nullable().default(null),
  expectedIncome: z.number().finite().nonnegative().nullable().default(null),
  sourceComment: z
    .union([
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({
        kind: z.literal("person"),
        id: uuid,
        name: z.string().optional(),
      }),
    ])
    .nullable()
    .default(null),
  comment: z.string().default(""),
  contacts: z
    .array(
      z.object({
        rowNumber: z.number().int().positive().optional(),
        typeId: z.string(),
        kindId: z.string().nullable().optional(),
        presentation: z.string(),
        comment: z.string().optional(),
      }),
    )
    .default([]),
  organization: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .default(null),
  source: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .default(null),
  university: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .default(null),
  responsible: z
    .object({
      kind: z.enum(["user", "person"]),
      id: uuid,
      name: z.string().optional(),
    })
    .nullable()
    .default(null),
  additionalResponsible: z
    .object({
      kind: z.enum(["user", "person"]),
      id: uuid,
      name: z.string().optional(),
    })
    .nullable()
    .default(null),
  gph: z.boolean().default(false),
  selfEmployed: z.boolean().default(false),
  unofficial: z.boolean().default(false),
  apprentice: z.boolean().default(false),
  internship: z.boolean().default(false),
  targetedContract: z.boolean().default(false),
  contractTraining: z.boolean().default(false),
  internshipStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  internshipEndDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
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
const erpCalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
export const previousDocumentsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().max(256),
      documentUid: uuid.nullable(),
      title: z.string().max(512),
      fields: z.record(z.unknown()),
      expiresAt: erpCalendarDate.nullable(),
      recordDate: erpCalendarDate.nullable().optional(),
      isInvalid: z.boolean().nullable().optional(),
      originalAvailable: z.boolean(),
      recheckStatus: z.enum(["REQUIRES_REVIEW", "ORIGINAL_UNAVAILABLE"]),
    }),
  ),
});
export const erpEmploymentHistorySchema = z.object({
  items: z
    .array(
      z.object({
        eventDate: erpCalendarDate,
        startDate: erpCalendarDate.nullable(),
        eventType: z.enum(["HIRE", "DISMISSAL"]),
      }),
    )
    .max(500),
});
export const referencesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      code: z.string().optional(),
      birthDate: z.string().nullable().optional(),
      candidateUids: z.array(uuid).optional(),
      kind: z.enum(["user", "person"]).optional(),
      typeId: z.string().optional(),
      editable: z.boolean().optional(),
      requiresProject: z.boolean().optional(),
      requiresPlannedArrivalDate: z.boolean().optional(),
    }),
  ),
});
export const personMatchesSchema = z.object({
  items: z
    .array(
      z.object({
        id: uuid,
        name: z.string().max(512),
        birthDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        latinName: z.string().max(512).nullable(),
        matchedCyrillic: z.boolean(),
        matchedLatin: z.boolean(),
        matchedPhone: z.boolean().default(false),
        matchedBirthDate: z.boolean().default(false),
        candidateUids: z.array(uuid).default([]),
      }),
    )
    .max(100),
  candidates: z
    .array(
      z.object({
        id: uuid,
        name: z.string(),
        birthDate: z.string().nullable(),
        matchedName: z.boolean(),
        matchedPhone: z.boolean(),
        matchedBirthDate: z.boolean(),
      }),
    )
    .max(100)
    .default([]),
});
export const erpOperationSchema = z.object({
  state: z.enum(["NOT_FOUND", "UNKNOWN", "COMPLETED"]),
  httpStatus: z.number().int().optional(),
  card: erpCardSchema.optional(),
  code: z.string().optional(),
});
export function safeOperationRejection(code: string | undefined) {
  return code &&
    (safeConflictCodes.has(code) ||
      safeBadRequestCodes.has(code) ||
      safeForbiddenCodes.has(code))
    ? code
    : undefined;
}

/** Shared narrow ERP business bridge. No automatic retries of mutations. */
@Injectable()
export class ErpWorkspaceClient {
  private readonly responseSignals = new WeakMap<Response, AbortSignal>();
  constructor(private readonly config: ConfigService) {}
  private async response(
    action: string,
    query: Record<string, string>,
    body?: unknown,
    signal?: AbortSignal,
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
    const deadline = AbortSignal.timeout(body === undefined ? 15000 : 45000);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    requestSignal.throwIfAborted();
    let response: Response;
    const isBuffer = Buffer.isBuffer(body) || body instanceof Uint8Array;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          token,
          ...(body === undefined
            ? {}
            : isBuffer
              ? { "Content-Type": "application/octet-stream" }
              : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : isBuffer
              ? (body as Buffer)
              : JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      signal?.throwIfAborted();
      throw new ServiceUnavailableException(
        body === undefined ? "ERP_UNAVAILABLE" : "ERP_OPERATION_RESULT_UNKNOWN",
      );
    }
    this.responseSignals.set(response, requestSignal);
    requestSignal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 409) {
        let code: unknown;
        try {
          const bytes = await this.readBounded(response, 8192);
          code = (JSON.parse(bytes.toString("utf8")) as { code?: unknown })
            .code;
        } catch {
          signal?.throwIfAborted();
          // Unknown or oversized upstream bodies must never leak to the client.
        }
        throw new ConflictException(
          typeof code === "string" && safeConflictCodes.has(code)
            ? code
            : "ERP_RELATION_OR_OPERATION_CONFLICT: требуется точечная проверка связи или результата операции в ERP",
        );
      }
      if (response.status === 403) {
        let code: unknown;
        try {
          const bytes = await this.readBounded(response, 8192);
          code = (JSON.parse(bytes.toString("utf8")) as { code?: unknown })
            .code;
        } catch {
          signal?.throwIfAborted();
          // Unknown or oversized upstream bodies must never leak to the client.
        }
        if (code === "ACTOR_NOT_FOUND_OR_AMBIGUOUS") {
          throw new ForbiddenException(
            "ERP_ACTOR_NOT_FOUND_OR_AMBIGUOUS: пользователь 1C для автора операции не найден или не сопоставлен с физическим лицом",
          );
        }
        if (code === "STATUS_OWNED_BY_DISPATCH_OR_HR") {
          throw new ForbiddenException(
            "STATUS_OWNED_BY_DISPATCH_OR_HR: этот статус меняется диспетчером или отделом кадров в ERP",
          );
        }
        throw new ForbiddenException(
          typeof code === "string" && safeForbiddenCodes.has(code)
            ? code
            : "ERP_FORBIDDEN: операция запрещена ERP",
        );
      }
      if (response.status === 400) {
        let err: unknown;
        try {
          const bytes = await this.readBounded(response, 8192);
          const parsed = JSON.parse(bytes.toString("utf8")) as {
            error?: unknown;
            code?: unknown;
          };
          err = parsed.error ?? parsed.code;
          if (
            typeof err === "object" &&
            err !== null &&
            (err as Record<string, unknown>).code === "INVALID_CURSOR"
          ) {
            err = "INVALID_CURSOR";
          }
        } catch {
          signal?.throwIfAborted();
          // Unknown or oversized upstream bodies must never leak to the client.
        }
        if (typeof err === "string" && safeBadRequestCodes.has(err)) {
          throw new BadRequestException(err);
        }
        throw new ServiceUnavailableException(
          body === undefined
            ? "ERP_UNAVAILABLE"
            : "ERP_OPERATION_RESULT_UNKNOWN",
        );
      }
      await response.body?.cancel();
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
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    query: Record<string, string> = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.response(action, query, body, signal);
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
        const r = await this.readChunk(
          reader,
          this.responseSignals.get(response),
        );
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
  /** Fetch resolves at headers; explicitly bound streamed body reads as well. */
  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    signal?.throwIfAborted();
    if (!signal) return reader.read();
    return new Promise((resolve, reject) => {
      const abort = () => {
        // Reject before cancellation can resolve the pending read as EOF.
        reject(signal.reason);
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      reader.read().then(
        (part) => {
          signal.removeEventListener("abort", abort);
          resolve(part);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }
  arrivalPage(limit: number, cursor?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (cursor !== undefined && (!cursor || cursor.length > 1024))
    )
      throw new Error("INVALID_ARRIVAL_PAGE");
    return this.request("ig-arrivals", arrivalPageSchema, {
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
  }
  arrivalFactsPage(limit: number, cursor?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor !== undefined && (!cursor || cursor.length > 1024))
    )
      throw new Error("INVALID_ARRIVAL_PAGE");
    return this.request("ig-arrivals", arrivalFactsPageSchema, {
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
    });
  }
  async identity(code1c: string, signal?: AbortSignal) {
    const identity = await this.request(
      "identity",
      erpIdentitySchema,
      {
        code1c,
      },
      undefined,
      signal,
    );
    if (identity.code1C !== code1c)
      throw new ConflictException("ERP_IDENTITY_MISMATCH");
    return identity;
  }
  employmentHistory(code1c: string, personUid: string, signal?: AbortSignal) {
    return this.request(
      "person-employment-history",
      erpEmploymentHistorySchema,
      { code1c, personUid },
      undefined,
      signal,
    );
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
  async probeCandidateOriginal(
    erpUid: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.response(
      "person-document-original",
      { candidate: erpUid, id },
      undefined,
      signal,
    );
    return this.verifyOriginalResponse(response);
  }

  async probePersonOriginal(
    code1c: string,
    personUid: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await this.response(
      "person-document-original-by-code",
      {
        code1c,
        personUid,
        id,
      },
      undefined,
      signal,
    );
    return this.verifyOriginalResponse(response);
  }

  private async verifyOriginalResponse(response: Response): Promise<boolean> {
    const mime = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/octet-stream",
    ];
    const rawLength = response.headers.get("content-length");
    if (
      !mime ||
      !allowed.includes(mime) ||
      (rawLength !== null &&
        (!/^\d+$/.test(rawLength) ||
          Number(rawLength) <= 0 ||
          Number(rawLength) > 100 * 1024 * 1024))
    ) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    if (!response.body) return false;
    const reader = response.body.getReader();
    let size = 0;
    let prefix = Buffer.alloc(0);
    try {
      for (;;) {
        const part = await this.readChunk(
          reader,
          this.responseSignals.get(response),
        );
        if (part.done) {
          const detected = prefix.subarray(0, 5).equals(Buffer.from("%PDF-"))
            ? "application/pdf"
            : prefix.length >= 3 &&
                prefix[0] === 0xff &&
                prefix[1] === 0xd8 &&
                prefix[2] === 0xff
              ? "image/jpeg"
              : prefix
                    .subarray(0, 8)
                    .equals(
                      Buffer.from([
                        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                      ]),
                    )
                ? "image/png"
                : prefix.length >= 12 &&
                    prefix.toString("ascii", 0, 4) === "RIFF" &&
                    prefix.toString("ascii", 8, 12) === "WEBP"
                  ? "image/webp"
                  : null;
          return (
            !!detected &&
            (mime === detected || mime === "application/octet-stream") &&
            (rawLength === null || Number(rawLength) === size)
          );
        }
        size += part.value.length;
        if (size > 100 * 1024 * 1024) return false;
        if (prefix.length < 12)
          prefix = Buffer.concat([
            prefix,
            Buffer.from(part.value.subarray(0, 12 - prefix.length)),
          ]);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  async personOriginal(
    code1c: string,
    personUid: string,
    id: string,
    signal?: AbortSignal,
  ) {
    const response = await this.response(
      "person-document-original-by-code",
      {
        code1c,
        personUid,
        id,
      },
      undefined,
      signal,
    );
    return {
      bytes: await this.readBounded(response, 100 * 1024 * 1024),
      mimeType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async fetchCandidatePhoto(
    target: { candidate?: string; personUid?: string; code1c?: string },
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    const query: Record<string, string> = {};
    if (target.candidate) query.candidate = target.candidate;
    if (target.personUid) query.personUid = target.personUid;
    if (target.code1c) query.code1c = target.code1c;
    try {
      const response = await this.response("photo", query, undefined, signal);
      const bytes = await this.readBounded(response, 20 * 1024 * 1024);
      return {
        buffer: bytes,
        contentType: response.headers.get("content-type") ?? "image/jpeg",
      };
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  async uploadCandidatePhoto(
    target: {
      candidate?: string;
      personUid?: string;
      code1c?: string;
      actor: string;
      requestId: string;
      extension: string;
    },
    buffer: Buffer,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; fileUid?: string; path?: string }> {
    const query: Record<string, string> = {
      actor: target.actor,
      requestId: target.requestId,
      extension: target.extension,
    };
    if (target.candidate) query.candidate = target.candidate;
    if (target.personUid) query.personUid = target.personUid;
    if (target.code1c) query.code1c = target.code1c;

    const response = await this.response("photo", query, buffer, signal);
    const bytes = await this.readBounded(response, 8192);
    try {
      return JSON.parse(bytes.toString("utf8")) as {
        success: boolean;
        fileUid?: string;
        path?: string;
      };
    } catch {
      throw new ServiceUnavailableException("INVALID_ERP_RESPONSE");
    }
  }
}
