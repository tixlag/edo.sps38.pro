import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { sign } from "jsonwebtoken";
import { AuthModule } from "../src/auth/auth.module";
import {
  AnnotationsController,
  AnnotationCatalogsController,
  AnnotationSourcesController,
} from "../src/annotations/annotations.controller";
import { AnnotationSourceService } from "../src/annotations/annotation-source.service";
import { AnnotationService } from "../src/annotations/annotation.service";
import { AnnotationCatalogService } from "../src/annotations/annotation-catalog.service";
import { HttpErrorFilter } from "../src/common/http-error.filter";
const secret = "annotation-http-synthetic-secret";
const headers = (accessRules: Record<string, string[]>) => ({
  authorization: `Bearer ${sign({ uuid: "annotation-http-reviewer", accessRules }, secret, { issuer: "lk-auth-service", algorithm: "HS256", expiresIn: 300 })}`,
});
let app: NestFastifyApplication;
describe("annotation HTTP guards and DTO validation", () => {
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: secret,
              JWT_ISSUER: "lk-auth-service",
              JWT_ALG: "HS256",
              ALLOW_INSECURE_DEV_AUTH: false,
            }),
          ],
        }),
        AuthModule,
      ],
      controllers: [
        AnnotationsController,
        AnnotationCatalogsController,
        AnnotationSourcesController,
      ],
      providers: [
        { provide: AnnotationSourceService, useValue: {} },
        {
          provide: AnnotationService,
          useValue: {
            preference: async () => ({ enabled: false }),
            setPreference: async (enabled: boolean) => ({ enabled }),
            mutate: async () => ({ id: "synthetic", status: "ACCEPTED" }),
          },
        },
        {
          provide: AnnotationCatalogService,
          useValue: { defaults: async () => ({ fields: [] }) },
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
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("emits only registered access JWT security references for annotation endpoints", () => {
    const config = new DocumentBuilder()
      .addBearerAuth(
        { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        "access-jwt",
      )
      .build();
    const document = SwaggerModule.createDocument(app, config);
    const schemes = document.components?.securitySchemes ?? {};
    const operations = Object.values(document.paths).flatMap((path) =>
      [path?.get, path?.post, path?.put, path?.delete].filter(
        (operation) => operation !== undefined,
      ),
    );
    expect(operations.length).toBeGreaterThan(0);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/annotations/preference",
        "/api/v1/annotation-catalogs",
        "/api/v1/documents/{documentId}/versions/{version}/annotation-sources",
      ]),
    );
    for (const operation of operations) {
      expect(operation.security).toEqual([{ "access-jwt": [] }]);
      for (const requirement of operation.security ?? [])
        for (const reference of Object.keys(requirement))
          expect(schemes).toHaveProperty(reference);
    }
  });
  it("requires a verified JWT and a review group independently of OCR or locations", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/annotations/preference",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/annotations/preference",
          headers: headers({ "20010": [] }),
        })
      ).statusCode,
    ).toBe(403);
    for (const rule of ["20002", "20011"]) {
      const result = await app.inject({
        method: "GET",
        url: "/api/v1/annotations/preference",
        headers: headers({ [rule]: [] }),
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ enabled: false });
    }
  });
  it("validates boolean and prevents undocumented request fields", async () => {
    for (const payload of [
      { enabled: "yes" },
      { enabled: true, actorId: "spoof" },
    ])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/annotations/preference",
            headers: headers({ "20002": [] }),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/annotations/preference",
          headers: headers({ "20002": [] }),
          payload: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("requires full access for acceptance and catalog defaults", async () => {
    for (const url of [
      "/api/v1/annotations/synthetic/accept",
      "/api/v1/annotation-catalogs/defaults/passport",
    ]) {
      const result = await app.inject({
        method: url.endsWith("accept") ? "POST" : "GET",
        url,
        headers: headers({ "20002": [] }),
        ...(url.endsWith("accept") ? { payload: { revision: 0 } } : {}),
      });
      expect(result.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/annotations/synthetic/accept",
          headers: headers({ "20009": [] }),
          payload: { revision: 0 },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("rejects invalid optimistic revisions before service mutation", async () => {
    for (const revision of [-1, 1.5, "zero"])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/annotations/synthetic/accept",
            headers: headers({ "20009": [] }),
            payload: { revision },
          })
        ).statusCode,
      ).toBe(400);
  });
});
