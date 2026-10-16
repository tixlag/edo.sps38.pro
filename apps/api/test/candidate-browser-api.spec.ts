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

const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
describe("EDO candidate browser API with unified auth", () => {
  let app: NestFastifyApplication;
  let jwt: JwtService;
  const identity = {
    byUuid: vi.fn(async () => ({ chatUuid: uuid, code1c: "000123" })),
  };
  const contexts = {
    context: vi.fn(async () => ({
      chatUuid: uuid,
      code1c: "000123",
      positionCode1c: "000491",
      citizenship: "ru",
      projectCode1c: "00008",
      candidateSnapshot: { uuid, name: "Иван" },
    })),
    ownChat: vi.fn(async () => uuid),
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
    expect(contexts.ownChat).toHaveBeenCalledWith("000123");
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
    "refuses own context if the link changed between LK lookups (%s)",
    async (code1c) => {
      contexts.context.mockResolvedValueOnce({
        chatUuid: uuid,
        code1c,
        positionCode1c: "000491",
        citizenship: "ru",
        projectCode1c: null,
        candidateSnapshot: { uuid, name: "Other" },
      } as never);
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
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("Other");
    },
  );
});
