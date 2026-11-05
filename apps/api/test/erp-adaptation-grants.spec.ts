import "reflect-metadata";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { sign } from "jsonwebtoken";
import { AuthModule } from "../src/auth/auth.module";
import { ErpAdaptationGrantsController } from "../src/documents/erp-adaptation-grants.controller";
import { IgEmploymentService } from "../src/documents/ig-employment.service";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
import { LkInternalGuard } from "../src/documents/lk-internal.guard";
import {
  ErpAdaptationGuard,
  ADAPTATION_ACCESS_TOKEN_HEADER,
} from "../src/documents/erp-adaptation.guard";
import { AdaptationGrantsDto } from "../src/documents/erp-adaptation-grants.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ConflictException } from "@nestjs/common";

describe("ErpAdaptationGrantsController", () => {
  const createMockService = () => ({
    applyGrant: vi.fn(),
  });

  const createMockSync = () => ({
    syncPreviousDocuments: vi.fn().mockResolvedValue(undefined),
  });

  it("applies a single adaptation grant and triggers previous documents sync", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue({ candidateId: "candidate-1", known: true });
    const sync = createMockSync();

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
      sync as unknown as CandidatePreviousDocumentsSyncService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result).toEqual({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          applied: true,
          known: true,
        },
      ],
    });

    expect(service.applyGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "УП00035198",
        citizenship: "UZ",
        personUid: "00000000-0000-4000-8000-000000000001",
        enabled: true,
      }),
    );
    expect(sync.syncPreviousDocuments).toHaveBeenCalledWith(
      "candidate-1",
      "system:adaptation",
      "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
    );
  });

  it("processes batch items independently when one succeeds and another encounters an identity mismatch", async () => {
    const service = createMockService();
    service.applyGrant
      .mockResolvedValueOnce({ candidateId: "candidate-1", known: true })
      .mockRejectedValueOnce(
        new ConflictException("ERP_PERSON_IDENTITY_MISMATCH"),
      );

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce1",
          code1c: "УП00000001",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce2",
          code1c: "УП00000002",
          personUid: "00000000-0000-4000-8000-000000000002",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result).toEqual({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce1",
          code1c: "УП00000001",
          applied: true,
          known: true,
        },
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce2",
          code1c: "УП00000002",
          applied: false,
          known: false,
          errorMessage: "ERP_PERSON_IDENTITY_MISMATCH",
        },
      ],
    });
  });

  it("handles repeated delivery safely (idempotent repeat)", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue({ candidateId: "candidate-1", known: true });

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const item = {
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00035198",
      personUid: "00000000-0000-4000-8000-000000000001",
      citizenship: "UZ",
      enabled: true,
    };

    const first = await controller.apply({ items: [item] });
    const second = await controller.apply({ items: [item] });

    expect(first.items[0]).toEqual({
      operationId: item.operationId,
      code1c: item.code1c,
      applied: true,
      known: true,
    });
    expect(second.items[0]).toEqual({
      operationId: item.operationId,
      code1c: item.code1c,
      applied: true,
      known: true,
    });
  });

  it("marks item as not applied when operationId conflicts with different code1c", async () => {
    const service = createMockService();
    service.applyGrant.mockRejectedValue(
      new ConflictException("IG_GRANT_EVENT_CONFLICT"),
    );

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00099999",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    });

    expect(result.items[0]).toEqual({
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00099999",
      applied: false,
      known: false,
      errorMessage: "IG_GRANT_EVENT_CONFLICT",
    });
  });

  it("handles enabled=false safely when candidate exists", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue({ candidateId: "candidate-1", known: true });

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: false,
        },
      ],
    });

    expect(result.items[0]).toEqual({
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00035198",
      applied: true,
      known: true,
    });
  });

  it("handles enabled=false safely when candidate does NOT exist (known=false)", async () => {
    const service = createMockService();
    service.applyGrant.mockResolvedValue({ candidateId: null, known: false });

    const controller = new ErpAdaptationGrantsController(
      service as unknown as IgEmploymentService,
    );

    const result = await controller.apply({
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: false,
        },
      ],
    });

    expect(result.items[0]).toEqual({
      operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      code1c: "УП00035198",
      applied: true,
      known: false,
    });
  });

  describe("guard and validation contracts", () => {
    it("is protected by ErpAdaptationGuard requiring token matching EDO_ERP_ADAPTATION_TOKEN via Bearer or x-adaptation-token", () => {
      const guard = new ErpAdaptationGuard({
        get: (k: string) =>
          k === "EDO_ERP_ADAPTATION_TOKEN" ? "adaptation-secret-token" : undefined,
      } as never);

      const context = (authorization?: string, customHeader?: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {
                authorization,
                [ADAPTATION_ACCESS_TOKEN_HEADER]: customHeader,
              },
            }),
          }),
        }) as never;

      // Missing header -> throws 401
      expect(() => guard.canActivate(context())).toThrow();
      // Wrong Bearer token -> throws 401
      expect(() => guard.canActivate(context("Bearer wrong-token"))).toThrow();
      // Wrong custom header -> throws 401
      expect(() => guard.canActivate(context(undefined, "wrong-token"))).toThrow();
      // Valid Bearer token -> passes
      expect(guard.canActivate(context("Bearer adaptation-secret-token"))).toBe(true);
      // Valid custom header -> passes
      expect(guard.canActivate(context(undefined, "adaptation-secret-token"))).toBe(true);
    });

    it("fails closed when EDO_ERP_ADAPTATION_TOKEN is not configured on server", () => {
      const guard = new ErpAdaptationGuard({
        get: () => undefined,
      } as never);

      const context = () =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {
                authorization: "Bearer any-token",
                [ADAPTATION_ACCESS_TOKEN_HEADER]: "any-token",
              },
            }),
          }),
        }) as never;

      expect(() => guard.canActivate(context())).toThrow();
    });

    it("validates DTO structure strictly", async () => {
      const empty = plainToInstance(AdaptationGrantsDto, { items: [] });
      const emptyErrors = await validate(empty);
      expect(emptyErrors.length).toBeGreaterThan(0);

      const invalidItem = plainToInstance(AdaptationGrantsDto, {
        items: [
          {
            operationId: "not-a-uuid",
            code1c: "",
            personUid: "also-not-a-uuid",
            citizenship: "",
            enabled: "not-a-boolean",
          },
        ],
      });
      const itemErrors = await validate(invalidItem);
      expect(itemErrors.length).toBeGreaterThan(0);

      const valid = plainToInstance(AdaptationGrantsDto, {
        items: [
          {
            operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "УП00035198",
            personUid: "00000000-0000-4000-8000-000000000001",
            citizenship: "UZ",
            enabled: true,
          },
        ],
      });
      const validErrors = await validate(valid);
      expect(validErrors.length).toBe(0);
    });
  });

  describe("full HTTP e2e with global JwtAuthGuard and ErpAdaptationGuard", () => {
    const jwtSecret = "erp-adaptation-synthetic-jwt-secret";
    const adaptationSecret = "shared-adaptation-token-123";
    const lkSecret = "lk-different-internal-token-456";
    let app: NestFastifyApplication;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [
              () => ({
                JWT_SECRET: jwtSecret,
                JWT_ISSUER: "lk-auth-service",
                JWT_ALG: "HS256",
                ALLOW_INSECURE_DEV_AUTH: false,
                EDO_ERP_ADAPTATION_TOKEN: adaptationSecret,
                EDO_LK_INTERNAL_TOKEN: lkSecret,
              }),
            ],
          }),
          AuthModule,
        ],
        controllers: [ErpAdaptationGrantsController],
        providers: [
          ErpAdaptationGuard,
          {
            provide: IgEmploymentService,
            useValue: {
              applyGrant: vi
                .fn()
                .mockResolvedValue({ candidateId: "cand-1", known: true }),
            },
          },
        ],
      }).compile();

      app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter(),
        { logger: false },
      );
      app.setGlobalPrefix("api");
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app?.close();
    });

    const validPayload = {
      items: [
        {
          operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "УП00035198",
          personUid: "00000000-0000-4000-8000-000000000001",
          citizenship: "UZ",
          enabled: true,
        },
      ],
    };

    it("rejects request with 401 when no credentials are provided", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects request with 401 when wrong token is provided", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        headers: { authorization: "Bearer invalid-token" },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects request with 401 when LK internal token is provided instead of adaptation token", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        headers: { authorization: `Bearer ${lkSecret}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects request with 401 when user JWT is provided instead of adaptation token", async () => {
      const userJwt = sign(
        { uuid: "user-uuid", accessRules: { "20009": [] } },
        jwtSecret,
        { issuer: "lk-auth-service", algorithm: "HS256", expiresIn: 300 },
      );
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        headers: { authorization: `Bearer ${userJwt}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(401);
    });

    it("accepts request with 200 when valid Bearer token is provided", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        headers: { authorization: `Bearer ${adaptationSecret}` },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [
          {
            operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "УП00035198",
            applied: true,
            known: true,
          },
        ],
      });
    });

    it("accepts request with 200 when valid x-adaptation-token header is provided", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/internal/erp/v1/adaptation-grants",
        headers: { [ADAPTATION_ACCESS_TOKEN_HEADER]: adaptationSecret },
        payload: validPayload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [
          {
            operationId: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "УП00035198",
            applied: true,
            known: true,
          },
        ],
      });
    });
  });
});
