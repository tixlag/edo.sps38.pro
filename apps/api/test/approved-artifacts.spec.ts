import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { validateEnv } from "../src/config/env.validation";
import {
  DocumentPdfService,
  mergeDocumentPdf,
} from "../src/documents/document-pdf.service";
import { Readable } from "node:stream";
import { MAX_APPROVED_BYTES } from "../src/documents/approved-artifact";

const directory = join(__dirname, "fixtures/approved-artifacts");
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const read = (name: string) => readFile(join(directory, name));
function fixture(bytes: Buffer, mimeType: string, transport = "multipart-v2") {
  const objects = new Map<string, Buffer>([["original", bytes]]);
  const row = {
    id: "v",
    documentId: "doc",
    version: 1,
    status: "IN_REVIEW",
    revision: 0,
    pendingApprovalStorageKey: null as string | null,
    approvedStorageKey: null as string | null,
    files: [
      {
        storageKey: "original",
        mimeType,
        sizeBytes: bytes.length,
        sha256: hash(bytes),
        pageCount: mimeType === "application/pdf" ? 3 : 1,
      },
    ],
  };
  const storage = {
    keyFor: (_id: string, _v: number, name: string) => `doc/v1/${name}`,
    read: vi.fn(async (key: string) => objects.get(key)!),
    openRead: vi.fn(async (key: string) => Readable.from([objects.get(key)!])),
    copy: vi.fn(async (from: string, to: string) => {
      objects.set(to, Buffer.from(objects.get(from)!));
    }),
    uploadBuffer: vi.fn(async (key: string, data: Buffer) => {
      objects.set(key, data);
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const tx = {
    $queryRaw: vi.fn(),
    documentVersion: {
      findUniqueOrThrow: vi.fn(async () => row),
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.revision !== undefined &&
          (row.status !== "IN_REVIEW" || row.pendingApprovalStorageKey)
        )
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    documentVersionFile: { findFirst: vi.fn(async () => null) },
  };
  const prisma = {
    ...tx,
    $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  };
  const service = new DocumentPdfService(
    prisma as never,
    storage as never,
    new ConfigService({ ERP_DOCUMENTS_TRANSPORT: transport }),
  );
  return { service, row, storage, objects, tx };
}

describe("approved artifacts and ownership", () => {
  it.each([
    ["passport.jpg", "image/jpeg", "jpg"],
    ["scan.png", "image/png", "png"],
    ["document.webp", "image/webp", "webp"],
    ["multipage.pdf", "application/pdf", "pdf"],
  ])("copies one %s unchanged", async (name, mimeType, extension) => {
    const bytes = await read(name);
    const f = fixture(bytes, mimeType);
    const artifact = await f.service.prepare("v", 0);
    expect(artifact).toMatchObject({
      mimeType,
      extension,
      sizeBytes: bytes.length,
      sha256: hash(bytes),
      transport: "multipart-v2",
    });
    expect(f.objects.get(artifact.key)!.equals(bytes)).toBe(true);
    expect(f.storage.copy).toHaveBeenCalledOnce();
    expect(f.storage.uploadBuffer).not.toHaveBeenCalled();
    expect(f.storage.read).not.toHaveBeenCalled();
    expect(f.objects.get("original")!.equals(bytes)).toBe(true);
    await expect(f.service.prepare("v", 0)).rejects.toThrow();
    expect(f.objects.size).toBe(2);
  });
  it("keeps v1 PDF preparation", async () => {
    const f = fixture(await read("passport.jpg"), "image/jpeg", "base64-v1");
    const artifact = await f.service.prepare("v", 0);
    expect(artifact).toMatchObject({
      transport: "base64-v1",
      mimeType: "application/pdf",
      extension: "pdf",
    });
    expect(
      (await PDFDocument.load(f.objects.get(artifact.key)!)).getPageCount(),
    ).toBe(1);
  });
  it("discards only owned pending objects, protects committed artifacts and originals", async () => {
    const f = fixture(await read("scan.png"), "image/png");
    const artifact = await f.service.prepare("v", 0);
    await f.service.discard("v", "original");
    expect(f.objects.has("original")).toBe(true);
    f.row.approvedStorageKey = artifact.key;
    await f.service.discard("v", artifact.key);
    expect(f.objects.has(artifact.key)).toBe(true);
    f.row.approvedStorageKey = null;
    await f.service.discard("v", artifact.key);
    expect(f.objects.has(artifact.key)).toBe(false);
    expect(f.objects.has("original")).toBe(true);
    expect(f.row.pendingApprovalStorageKey).toBeNull();
  });
  it("cleans failed preparation without touching originals", async () => {
    const f = fixture(await read("scan.png"), "image/png");
    f.storage.copy.mockImplementationOnce(async () => {
      throw new Error("S3 down");
    });
    await expect(f.service.prepare("v", 0)).rejects.toThrow("S3 down");
    expect(f.objects.size).toBe(1);
    expect(f.objects.has("original")).toBe(true);
    expect(f.row.pendingApprovalStorageKey).toBeNull();
  });
  it("detects corruption in a copied object", async () => {
    const f = fixture(await read("passport.jpg"), "image/jpeg");
    f.storage.copy.mockImplementationOnce(async (_from, to) => {
      f.objects.set(to, Buffer.from("changed"));
    });
    await expect(f.service.prepare("v", 0)).rejects.toThrow("MISMATCH");
    expect(f.objects.size).toBe(1);
  });
});

describe("PDF composition", () => {
  it.each([
    ["passport.jpg", "passport.jpg"],
    ["scan.png", "scan.png"],
    ["document.webp", "passport.jpg"],
    ["passport.jpg", "multipage.pdf"],
    ["multipage.pdf", "multipage.pdf"],
  ])("assembles %s + %s in order", async (a, b) => {
    const mime = (name: string) =>
      name.endsWith("jpg")
        ? "image/jpeg"
        : name.endsWith("png")
          ? "image/png"
          : name.endsWith("webp")
            ? "image/webp"
            : "application/pdf";
    const bytes = await mergeDocumentPdf(
      await Promise.all(
        [a, b].map(async (name) => ({
          mimeType: mime(name),
          bytes: await read(name),
        })),
      ),
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(
      (a.endsWith("pdf") ? 3 : 1) + (b.endsWith("pdf") ? 3 : 1),
    );
    const dimensions = pdf.getPages().map((p) => [p.getWidth(), p.getHeight()]);
    const dims = (name: string) =>
      name.endsWith("pdf")
        ? [
            [210, 297],
            [300, 400],
            [500, 200],
          ]
        : [[1200, 900]];
    expect(dimensions).toEqual([...dims(a), ...dims(b)]);
    if (a.endsWith("jpg") && b.endsWith("jpg")) {
      const images = pdf.context
        .enumerateIndirectObjects()
        .map(([, o]) => o)
        .filter(
          (o): o is PDFRawStream =>
            o instanceof PDFRawStream &&
            o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
        );
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) {
        expect(image.dict.get(PDFName.of("Filter"))?.toString()).toBe(
          "/DCTDecode",
        );
        expect(
          Buffer.from(image.getContents()).equals(await read("passport.jpg")),
        ).toBe(true);
      }
    }
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "keeps EXIF orientation %i and direct JPEG data",
    async (orientation) => {
      const original = await sharp(await read("passport.jpg"))
        .withMetadata({ orientation })
        .jpeg({ quality: 92 })
        .toBuffer();
      const f = fixture(original, "image/jpeg");
      const artifact = await f.service.prepare("v", 0);
      expect(f.objects.get(artifact.key)!.equals(original)).toBe(true);
      expect(
        (await sharp(f.objects.get(artifact.key)!).metadata()).orientation,
      ).toBe(orientation);
      const pdf = await PDFDocument.load(
        await mergeDocumentPdf([{ bytes: original, mimeType: "image/jpeg" }]),
      );
      expect(pdf.getPage(0).getSize()).toEqual(
        orientation >= 5
          ? { width: 900, height: 1200 }
          : { width: 1200, height: 900 },
      );
    },
  );
  it("keeps PNG alpha as a PDF soft mask", async () => {
    const pdf = await PDFDocument.load(
      await mergeDocumentPdf([
        { bytes: await read("transparent.png"), mimeType: "image/png" },
      ]),
    );
    const images = pdf.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o) => o instanceof PDFRawStream);
    expect(
      images.some((o) => (o as PDFRawStream).dict.has(PDFName.of("SMask"))),
    ).toBe(true);
  });
  it("uses a lossless fallback only when direct JPEG embedding is unsupported", async () => {
    const original = await read("passport.jpg");
    const direct = vi
      .spyOn(PDFDocument.prototype, "embedJpg")
      .mockRejectedValueOnce(new Error("Unsupported JPEG variant"));
    try {
      const bytes = await mergeDocumentPdf([
        { mimeType: "image/jpeg", bytes: original },
      ]);
      expect((await PDFDocument.load(bytes)).getPage(0).getSize()).toEqual({
        width: 1200,
        height: 900,
      });
      expect(direct).toHaveBeenCalledOnce();
      expect(original.equals(await read("passport.jpg"))).toBe(true);
    } finally {
      direct.mockRestore();
    }
  });
  it("preserves transparency in a WebP mixed bundle", async () => {
    const webp = await sharp(await read("transparent.png"))
      .webp({ lossless: true })
      .toBuffer();
    const pdf = await PDFDocument.load(
      await mergeDocumentPdf([
        { mimeType: "image/webp", bytes: webp },
        { mimeType: "image/jpeg", bytes: await read("passport.jpg") },
      ]),
    );
    expect(pdf.getPageCount()).toBe(2);
    expect(
      pdf.context
        .enumerateIndirectObjects()
        .some(
          ([, o]) =>
            o instanceof PDFRawStream && o.dict.has(PDFName.of("SMask")),
        ),
    ).toBe(true);
  });
  it("enforces page, file count and artifact size boundaries", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 100; i++) pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    await expect(
      mergeDocumentPdf([{ mimeType: "application/pdf", bytes }]),
    ).resolves.toEqual(bytes);
    await expect(
      mergeDocumentPdf([
        { mimeType: "application/pdf", bytes },
        { mimeType: "image/png", bytes: await read("scan.png") },
      ]),
    ).rejects.toThrow("100 pages");
    await expect(
      mergeDocumentPdf(
        Array(11).fill({ mimeType: "image/png", bytes: Buffer.from("x") }),
      ),
    ).rejects.toThrow();
    const f = fixture(Buffer.alloc(1), "image/jpeg");
    f.row.files[0].sizeBytes = MAX_APPROVED_BYTES + 1;
    await expect(f.service.prepare("v", 0)).rejects.toThrow("MISMATCH");
  });
});

describe("ERP transport configuration", () => {
  const base = {
    DATABASE_URL: "mysql://test:test@127.0.0.1:3308/edo",
    JWT_SECRET: "test-only",
  };
  it("defaults new approvals to v2, with retries off and a bounded deadline", () => {
    expect(validateEnv(base)).toMatchObject({
      ERP_DOCUMENTS_TRANSPORT: "multipart-v2",
      ERP_DOCUMENTS_V2_AUTO_RETRY: "false",
      ERP_DOCUMENTS_V2_TIMEOUT_MS: 300000,
    });
    expect(
      validateEnv({ ...base, ERP_DOCUMENTS_TRANSPORT: "base64-v1" })
        .ERP_DOCUMENTS_TRANSPORT,
    ).toBe("base64-v1");
  });
  it.each([
    { ERP_DOCUMENTS_TRANSPORT: "unknown" },
    { ERP_DOCUMENTS_V2_TIMEOUT_MS: 59999 },
    { ERP_DOCUMENTS_V2_TIMEOUT_MS: 600001 },
  ])("rejects unsafe settings %o", (input) => {
    expect(() => validateEnv({ ...base, ...input })).toThrow();
  });
});
