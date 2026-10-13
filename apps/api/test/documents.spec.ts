import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { DocumentUploadService } from "../src/documents/document-upload.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { LkInternalGuard } from "../src/documents/lk-internal.guard";
import { StubOcrService } from "../src/ocr/stub-ocr.service";
import { validateEnv } from "../src/config/env.validation";

const parser = new DocumentUploadService();
const principal = (accessRules: Record<string, string[]>) => ({
  uuid: "reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules,
});

describe("document files: inspect actual contents", () => {
  it("accepts valid JPEG, PNG and WebP", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const image = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "white" },
      })
        .toFormat(format)
        .toBuffer();
      expect(await parser.inspect(image)).toEqual({
        mimeType: `image/${format}`,
        pageCount: 1,
      });
    }
  });
  it("preserves a multi-page PDF as one file with its page count", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    expect(await parser.inspect(Buffer.from(await pdf.save()))).toEqual({
      mimeType: "application/pdf",
      pageCount: 2,
    });
  });
  it("rejects empty, damaged, disguised and truncated files", async () => {
    await expect(parser.inspect(Buffer.alloc(0))).rejects.toThrow("Empty");
    await expect(
      parser.inspect(Buffer.from("%PDF-1.7\nnot a pdf")),
    ).rejects.toThrow("damaged");
    await expect(
      parser.inspect(Buffer.from("<svg>not a jpg</svg>")),
    ).rejects.toThrow("Only JPEG");
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await expect(parser.inspect(png.subarray(0, 40))).rejects.toThrow(
      "damaged",
    );
  });
  it("rejects encrypted PDF even with no supplied password", async () => {
    const encrypted = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n3 0 obj\n<< /Filter /Standard /V 1 /R 2 /O () /U () /P -4 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 3 0 R /Size 4 >>\n%%EOF",
    );
    await expect(parser.inspect(encrypted)).rejects.toThrow(
      "password-protected",
    );
  });
});

describe("document authorization boundaries", () => {
  it("fails closed with missing token and rejects JWTs in the service route", () => {
    const guard = new LkInternalGuard({ get: () => "service-token" } as never);
    const context = (authorization?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } }),
        }),
      }) as never;
    expect(() => guard.canActivate(context())).toThrow();
    expect(() => guard.canActivate(context("Bearer other-token"))).toThrow();
    expect(guard.canActivate(context("Bearer service-token"))).toBe(true);
    expect(() =>
      new LkInternalGuard({ get: () => "" } as never).canActivate(
        context("Bearer service-token"),
      ),
    ).toThrow();
  });
  it("uses key presence and denies candidates without objects to scoped users", () => {
    const access = new DocumentAccessService({} as never);
    expect(access.candidateWhere(principal({ "20009": [] }))).toEqual({});
    expect(access.candidateWhere(principal({ "20008": [] }))).toEqual({});
    expect(access.candidateWhere(principal({ "20007": ["98"] }))).toEqual({
      locationId: { in: [98] },
    });
    expect(access.candidateWhere(principal({ "20000": [] }))).toEqual({
      locationId: { in: [] },
    });
  });
  it("disables stub by default and forbids it in production", () => {
    const config = (mode: string, env: string) =>
      ({ get: (k: string) => ({ OCR_MODE: mode, NODE_ENV: env })[k] }) as never;
    expect(new StubOcrService(config("disabled", "test")).isAvailable()).toBe(
      false,
    );
    expect(new StubOcrService(config("stub", "test")).isAvailable()).toBe(true);
    expect(new StubOcrService(config("stub", "production")).isAvailable()).toBe(
      false,
    );
    expect(() =>
      validateEnv({
        DATABASE_URL: "mysql://edo:edo@localhost/edo",
        JWT_SECRET: "real-secret",
        NODE_ENV: "production",
        OCR_MODE: "stub",
      }),
    ).toThrow("forbidden");
  });
});
