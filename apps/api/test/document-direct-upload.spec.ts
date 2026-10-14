import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { CandidateDocumentUploadController } from "../src/documents/manual-documents.controller";
import {
  DocumentUploadGrantGuard,
  DocumentUploadGrantService,
} from "../src/documents/document-upload-grant.service";
import { DocumentUploadService } from "../src/documents/document-upload.service";
import { ManualDocumentService } from "../src/documents/manual-document.service";

const context = {
  documentUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81",
  chat_uuid: "00000000-0000-4000-8000-000000000001",
  position_code_1c: "000000491",
  citizenship: "ru",
  code_1c: "00123",
};
describe("direct browser document upload", () => {
  let app: NestFastifyApplication;
  let grants: DocumentUploadGrantService;
  let image: Buffer;
  const upload = vi
    .fn()
    .mockResolvedValue({
      documentId: "document",
      version: 1,
      status: "IN_REVIEW",
    });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CandidateDocumentUploadController],
      providers: [
        DocumentUploadService,
        DocumentUploadGrantService,
        DocumentUploadGrantGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            EDO_LK_INTERNAL_TOKEN: "test-service",
            EDO_PUBLIC_API_URL: "https://edo.example/api",
          }),
        },
        { provide: ManualDocumentService, useValue: { upload } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    app.setGlobalPrefix("api");
    await app.register(multipart);
    await app.init();
    grants = app.get(DocumentUploadGrantService);
    image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => upload.mockClear());
  function body(metadata: unknown) {
    return Buffer.concat([
      Buffer.from(
        `--bundle\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--bundle\r\nContent-Disposition: form-data; name="files[]"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      image,
      Buffer.from("\r\n--bundle--\r\n"),
    ]);
  }
  function headers() {
    const { token } = grants.grant({
      ...context,
      idempotencyKey: "bundle-key",
    });
    return {
      authorization: `Bearer ${token}`,
      "idempotency-key": "bundle-key",
      "content-type": "multipart/form-data; boundary=bundle",
    };
  }
  it("reads multipart files directly and takes owner identity from the grant", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/candidate-documents",
      headers: headers(),
      payload: body({
        documentUid: context.documentUid,
        documentFields: { number: "000123", isInvalid: false },
      }),
    });
    expect(response.statusCode).toBe(202);
    const [staged, key] = upload.mock.calls[0];
    expect(staged.metadata).toEqual({
      ...context,
      documentFields: { number: "000123", isInvalid: false },
    });
    expect(staged.files).toHaveLength(1);
    expect(staged.files[0].mimeType).toBe("image/png");
    expect(key).toBe("bundle-key");
  });
  it.each([
    { chat_uuid: "00000000-0000-4000-8000-000000000002" },
    { position_code_1c: "forged" },
    { documentUid: "00000000-0000-4000-8000-000000000002" },
  ])(
    "rejects forged browser context before registering a document: %j",
    async (forged) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/candidate-documents",
        headers: headers(),
        payload: body({
          documentUid: context.documentUid,
          documentFields: { number: "000123" },
          ...forged,
        }),
      });
      expect(response.statusCode).toBe(400);
      expect(upload).not.toHaveBeenCalled();
    },
  );
  it("rejects a grant for another bundle and missing credentials", async () => {
    for (const authorization of [
      headers().authorization,
      "Bearer test-service",
      "",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/candidate-documents",
        headers: {
          ...headers(),
          authorization,
          "idempotency-key": "other-key",
        },
        payload: body({ documentUid: context.documentUid, documentFields: {} }),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(upload).not.toHaveBeenCalled();
  });
});
