import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { NotFoundException, ValidationPipe } from "@nestjs/common";
import { AuthModule } from "../src/auth/auth.module";
import { JwtService } from "../src/auth/jwt.service";
import {
  BrowserCandidateDocumentsController,
  MyCandidateDocumentsController,
} from "../src/documents/candidate-browser.controller";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import { CandidateContextService } from "../src/documents/candidate-context.service";
import { LkCandidateIdentityService } from "../src/documents/lk-candidate-identity.service";
import { DocumentCatalogService } from "../src/documents/document-catalog.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentEventsService } from "../src/documents/document-events.service";
import { DocumentUploadGrantService } from "../src/documents/document-upload-grant.service";

import { HttpErrorFilter } from "../src/common/http-error.filter";
import { CandidateDocumentError } from "../src/documents/candidate-document.error";
import {
  CandidateDocumentErrorCode as Code,
  CandidateProfileField as Field,
} from "../src/documents/dto/candidate-error.dto";

const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
describe("EDO candidate browser API with unified auth", () => {
  let app: NestFastifyApplication;
  let jwt: JwtService;
  const identity = {
    byUuid: vi.fn(async () => ({ chatUuid: uuid, code1c: "000123" })),
    byEmployee: vi.fn(async (code1c: string) => ({ chatUuid: uuid, code1c })),
  };
  const contexts = {
    forEmployee: vi.fn(async (code1c: string) => ({
      candidateId: "edo-current-cycle",
      chatUuid: uuid,
      code1c,
      positionCode1c: "000491",
      citizenship: "ru",
      projectCode1c: "00008",
      candidateSnapshot: { uuid, name: "Иван" },
    })),
    context: vi.fn(async () => ({
      chatUuid: uuid,
      code1c: "000123",
      positionCode1c: "000491",
      citizenship: "ru",
      projectCode1c: "00008",
      candidateSnapshot: { uuid, name: "Иван" },
    })),
    forIdentity: vi.fn(async (chat: { chatUuid: string; code1c: string }) => ({
      ...chat,
      positionCode1c: "000491",
      citizenship: "ru",
      projectCode1c: "00008",
      candidateSnapshot: { uuid, name: "Иван" },
    })),
  };
  const reads = {
    internalDocuments: vi.fn(async () => ({ items: [] })),
    internalDraft: vi.fn(async () => ({
      documentUid: uuid,
      version: 1,
      fields: [],
    })),
  };
  const events = {
    grant: vi.fn(async () => ({
      token: "sse",
      url: "https://edo/api/events",
      expiresAt: "later",
    })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: "test-identity-secret",
              JWT_ISSUER: "lk-auth-service",
            }),
          ],
        }),
        AuthModule,
      ],
      controllers: [
        BrowserCandidateDocumentsController,
        MyCandidateDocumentsController,
      ],
      providers: [
        CandidateDocumentsService,
        DocumentUploadGrantService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: "test-identity-secret",
            JWT_ISSUER: "lk-auth-service",
            EDO_LK_INTERNAL_TOKEN: "service-secret",
            EDO_PUBLIC_API_URL: "https://edo/api",
          }),
        },
        { provide: CandidateContextService, useValue: contexts },
        { provide: LkCandidateIdentityService, useValue: identity },
        {
          provide: DocumentCatalogService,
          useValue: { list: async () => ({ items: [] }) },
        },
        { provide: DocumentReadService, useValue: reads },
        { provide: DocumentEventsService, useValue: events },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new HttpErrorFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwt = app.get(JwtService);
  });
  afterAll(async () => {
    await app?.close();
  });
  it("allows an unregistered candidate to read statuses without ERP or a user JWT", async () => {
    contexts.context.mockClear();
    const response = await app.inject({
      method: "GET",
      url: `/api/candidate-documents/by-chat/${uuid}/statuses`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(contexts.context).not.toHaveBeenCalled();
  });
  it("does not expose documents for an unknown LK chat", async () => {
    identity.byUuid.mockRejectedValueOnce(new NotFoundException());
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/candidate-documents/by-chat/${uuid}/statuses`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("requires a real auth-service JWT for own chat and does not require administrative EDO rules", async () => {
    const url = "/api/candidate-documents/my/chat";
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const token = jwt.signForTest({
      uuid: "employee",
      code_1c: "000123",
      sid: "session",
      accessRules: {},
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer " + token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().chatUuid).toBe(uuid);
    expect(contexts.forEmployee).toHaveBeenCalledWith(
      "000123",
      expect.any(AbortSignal),
    );
    const expired = jwt.signForTest({
      uuid: "employee",
      code_1c: "000123",
      exp: 1,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Bearer " + expired },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url,
          headers: { authorization: "Bearer service-secret" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("mints an upload grant with server context and rejects client identity overrides", async () => {
    const url = `/api/candidate-documents/by-chat/${uuid}/upload-grant`;
    const response = await app.inject({
      method: "POST",
      url,
      payload: { documentUid: uuid, idempotencyKey: "bundle" },
    });
    expect(response.statusCode).toBe(200);
    expect(
      app.get(DocumentUploadGrantService).verify(response.json().token),
    ).toMatchObject({
      context: {
        chat_uuid: uuid,
        code_1c: "000123",
        position_code_1c: "000491",
      },
      idempotencyKey: "bundle",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: {
            documentUid: uuid,
            idempotencyKey: "bundle",
            code_1c: "other",
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("never caches draft field values in HTTP caches", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/candidate-documents/by-chat/${uuid}/documents/${uuid}/draft`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it.each([null, "other-employee"])(
    "refuses a mismatched canonical employee association (%s)",
    async (_code1c) => {
      contexts.forEmployee.mockRejectedValueOnce(
        new CandidateDocumentError(Code.ERP_CONTRACT_ERROR),
      );
      /* legacy LK association no longer used
      identity.byEmployee.mockResolvedValueOnce({
        chatUuid: uuid,
        code1c,
        positionCode1c: "000491",
        citizenship: "ru",
        projectCode1c: null,
        candidateSnapshot: { uuid, name: "Other" },
      } as never); */
      const token = jwt.signForTest({
        uuid: "employee",
        code_1c: "000123",
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const response = await app.inject({
        method: "GET",
        url: "/api/candidate-documents/my/chat",
        headers: { authorization: "Bearer " + token },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json().code).toBe("ERP_CONTRACT_ERROR");
      expect(response.body).not.toContain("Other");
    },
  );
  function authorization(code1c: string | null = "УП000123") {
    return {
      authorization:
        "Bearer " +
        jwt.signForTest({
          uuid: "employee",
          ...(code1c === null ? {} : { code_1c: code1c }),
          accessRules: {},
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
    };
  }
  it("returns forms and catalog from one canonical Unicode employee lookup", async () => {
    contexts.forEmployee.mockClear();
    identity.byUuid.mockClear();
    const response = await app.inject({
      method: "GET",
      url: "/api/candidate-documents/my/forms",
      headers: authorization(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      context: { code1c: "УП000123" },
      catalog: { items: [] },
    });
    expect(contexts.forEmployee).toHaveBeenCalledOnce();
    expect(identity.byUuid).not.toHaveBeenCalled();
  });
  it.each(["statuses", `documents/${uuid}/draft`, "stream-grant"])(
    "reads own %s after confirmed ERP identity without administrative permissions",
    async (path) => {
      contexts.context.mockClear();
      contexts.forIdentity.mockClear();
      const response = await app.inject({
        method: path === "stream-grant" ? "POST" : "GET",
        url: `/api/candidate-documents/my/${path}`,
        headers: authorization(),
      });
      expect(response.statusCode).toBe(200);
      expect(contexts.context).not.toHaveBeenCalled();
      expect(contexts.forIdentity).not.toHaveBeenCalled();
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );
  it.each([
    "forms",
    "statuses",
    `documents/${uuid}/draft`,
    "stream-grant",
    "upload-grant",
  ])("requires JWT on own %s", async (path) => {
    const response = await app.inject({
      method: path.endsWith("grant") ? "POST" : "GET",
      url: `/api/candidate-documents/my/${path}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "AUTH_REQUIRED",
      retryable: false,
    });
  });
  it("does not try token refresh semantics for an authenticated user missing an employee code", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/candidate-documents/my/forms",
      headers: authorization(null),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "EMPLOYEE_IDENTITY_REQUIRED",
      retryable: false,
    });
  });
  it("preserves actionable profile errors and safe field names through the global filter", async () => {
    contexts.forEmployee.mockRejectedValueOnce(
      new CandidateDocumentError(Code.CANDIDATE_PROFILE_INCOMPLETE, [
        Field.CITIZENSHIP,
      ]),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/candidate-documents/my/forms",
      headers: authorization(),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "CANDIDATE_PROFILE_INCOMPLETE",
      retryable: false,
      fields: ["citizenship"],
    });
    expect(response.json().message).toContain("гражданство");
    expect(response.json()).toHaveProperty("correlationId");
  });
  it("issues own upload capabilities from server identity and forbids owner overrides", async () => {
    const url = "/api/candidate-documents/my/upload-grant";
    const response = await app.inject({
      method: "POST",
      url,
      headers: authorization(),
      payload: { documentUid: uuid, idempotencyKey: "own-bundle" },
    });
    expect(response.statusCode).toBe(200);
    expect(
      app.get(DocumentUploadGrantService).verify(response.json().token),
    ).toMatchObject({ context: { chat_uuid: uuid, code_1c: "УП000123" } });
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: authorization(),
          payload: {
            documentUid: uuid,
            idempotencyKey: "own-bundle",
            code_1c: "other",
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});
