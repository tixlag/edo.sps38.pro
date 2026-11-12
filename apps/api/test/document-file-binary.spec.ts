import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { Readable } from "node:stream";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentsController } from "../src/documents/documents.controller";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import type { FastifyReply } from "fastify";

describe("Document file binary streaming", () => {
  const principal: AuthPrincipal = {
    uuid: "test-principal",
    code1c: null,
    sid: null,
    deviceId: null,
    expiresAt: null,
    accessRules: { "20000": [] },
  };

  it("fileStream verifies document access, finds file, and opens S3 stream", async () => {
    const stream = Readable.from(["chunk1", "chunk2"]);
    const storage = {
      openRead: vi.fn(async () => stream),
    };
    const prisma = {
      documentVersionFile: {
        findFirst: vi.fn(async () => ({
          id: "file-1",
          storageKey: "documents/doc-1/v1/scan.jpg",
          filename: "Паспорт.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 12345,
        })),
      },
    };
    const access = {
      document: vi.fn(async () => ({ id: "doc-1" })),
    };

    const service = new DocumentReadService(
      prisma as never,
      access as never,
      storage as never,
    );

    const result = await service.fileStream("doc-1", 1, "file-1", principal);

    expect(access.document).toHaveBeenCalledWith("doc-1", principal);
    expect(prisma.documentVersionFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "file-1",
          deletedAt: null,
        }),
      }),
    );
    expect(storage.openRead).toHaveBeenCalledWith(
      "documents/doc-1/v1/scan.jpg",
      expect.any(AbortSignal),
    );
    expect(result.filename).toBe("Паспорт.jpg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(12345);
    expect(result.stream).toBe(stream);
  });

  it("fileStream throws NotFoundException when file record is not found", async () => {
    const prisma = {
      documentVersionFile: {
        findFirst: vi.fn(async () => null),
      },
    };
    const access = {
      document: vi.fn(async () => ({ id: "doc-1" })),
    };

    const service = new DocumentReadService(
      prisma as never,
      access as never,
      {} as never,
    );

    await expect(
      service.fileStream("doc-1", 1, "missing-file", principal),
    ).rejects.toThrow(NotFoundException);
  });

  it("DocumentsController.file sets response headers and sends the stream", async () => {
    const stream = Readable.from(["bytes"]);
    const reads = {
      fileStream: vi.fn(async () => ({
        stream,
        mimeType: "image/jpeg",
        filename: "IMG_20261111_121518.jpg",
        sizeBytes: 2048,
      })),
    };
    const controller = new DocumentsController(
      reads as never,
      {} as never,
      {} as never,
    );

    const headers: Record<string, string | number> = {};
    const reply = {
      header: vi.fn((key: string, value: string | number) => {
        headers[key] = value;
        return reply;
      }),
      send: vi.fn((body: unknown) => body),
    } as unknown as FastifyReply;

    await controller.file("doc-1", 1, "file-1", principal, reply);

    expect(reads.fileStream).toHaveBeenCalledWith(
      "doc-1",
      1,
      "file-1",
      principal,
    );
    expect(headers["Content-Type"]).toBe("image/jpeg");
    expect(headers["Content-Length"]).toBe(2048);
    expect(headers["Content-Disposition"]).toBe(
      'inline; filename="IMG_20261111_121518.jpg"',
    );
    expect(headers["Cache-Control"]).toBe("private, max-age=300");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(reply.send).toHaveBeenCalledWith(stream);
  });
});
