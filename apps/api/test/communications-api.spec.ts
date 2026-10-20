import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AuthModule } from "../src/auth/auth.module";
import { JwtService } from "../src/auth/jwt.service";
import { CommunicationsController } from "../src/communications/communications.controller";
import { CommunicationsService } from "../src/communications/communications.service";
import { CommunicationEventsService } from "../src/communications/communication-events.service";
import { CandidateCatalogService } from "../src/communications/candidate-catalog.service";

describe("communications HTTP authorization and DTO boundary", () => {
  let app: NestFastifyApplication, jwt: JwtService;
  const chats = {
    context: vi.fn(async () => ({
      recipients: [],
      templates: [],
      canSend: false,
      lkUrl: null,
      unavailableSources: [],
    })),
    send: vi.fn(async () => ({
      id: "operation",
      status: "SENT",
      providerId: null,
      errorCode: null,
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
              JWT_SECRET: "communications-api-secret",
              JWT_ISSUER: "lk-auth-service",
            }),
          ],
        }),
        AuthModule,
      ],
      controllers: [CommunicationsController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            JWT_SECRET: "communications-api-secret",
            JWT_ISSUER: "lk-auth-service",
          }),
        },
        { provide: CommunicationsService, useValue: chats },
        {
          provide: CandidateCatalogService,
          useValue: {
            list: vi.fn(async () => ({
              items: [],
              nextCursor: null,
              syncedAt: null,
            })),
          },
        },
        { provide: CommunicationEventsService, useValue: { grant: vi.fn() } },
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
  afterAll(async () => app?.close());
  function headers(
    rules: Record<string, string[]> = {
      "20000": [],
      "20002": [],
      "20007": ["98"],
    },
  ) {
    return {
      authorization: `Bearer ${jwt.signForTest({ uuid: "reviewer", code_1c: "EMP01", accessRules: rules, exp: Math.floor(Date.now() / 1000) + 60 })}`,
    };
  }
  const payload = {
    requestId: "ed615f0c-84ab-4f18-8f73-3d51139738af",
    channel: "sms",
    recipientId: "phone",
    text: "Сообщение",
  };
  it("requires unified JWT authentication for context and catalog", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/candidates/catalog" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/candidates/c1/communications",
        })
      ).statusCode,
    ).toBe(401);
  });
  it("permits reading with ACCESS while rejecting a send without DOCUMENT_REVIEW", async () => {
    const reader = headers({ "20000": [], "20007": ["98"] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/candidates/c1/communications",
          headers: reader,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/candidates/c1/communications/messages",
          headers: reader,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(chats.send).not.toHaveBeenCalled();
  });
  it("pins actor identity to the JWT and strips forged body properties", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/candidates/c1/communications/messages",
      headers: headers(),
      payload: { ...payload, actor: "forged-actor" },
    });
    expect(response.statusCode).toBe(200);
    expect(chats.send).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ code1c: "EMP01" }),
      expect.not.objectContaining({ actor: "forged-actor" }),
    );
  });
  it.each([
    { ...payload, channel: "email" },
    { ...payload, requestId: "not-uuid" },
    { ...payload, attachmentIds: ["bad-id"] },
    { ...payload, text: "x".repeat(16001) },
  ])("rejects invalid sends at the public boundary", async (body) => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/candidates/c1/communications/messages",
          headers: headers(),
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("validates candidate catalog pagination bounds", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/candidates/catalog?limit=101",
          headers: headers(),
        })
      ).statusCode,
    ).toBe(400);
  });
});
