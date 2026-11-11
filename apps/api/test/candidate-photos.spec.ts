import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import sharp from "sharp";
import { CandidatePhotosService } from "../src/documents/candidate-photos.service";
import { CandidatePhotosController } from "../src/documents/candidate-photos.controller";
import type { AuthPrincipal } from "../src/auth/auth-principal";

describe("CandidatePhotosService & CandidatePhotosController", () => {
  const ruPrincipal = {
    uuid: "reviewer-ru",
    code1c: "emp-ru",
    accessRules: { "20002": [] },
  } as unknown as AuthPrincipal;

  const igPrincipal = {
    uuid: "reviewer-ig",
    code1c: "emp-ig",
    accessRules: { "20011": [] },
  } as unknown as AuthPrincipal;

  const adminPrincipal = {
    uuid: "admin",
    code1c: "emp-admin",
    accessRules: { "20009": [] },
  } as unknown as AuthPrincipal;

  const unauthorizedPrincipal = {
    uuid: "user-none",
    code1c: null,
    accessRules: {},
  } as unknown as AuthPrincipal;

  const ruCandidate = {
    id: "cand-ru-1",
    citizenship: "ru",
    erpUid: "erp-cand-1",
    code1c: null,
    personUid: null,
    chatUuid: "chat-uuid-1",
    photoPath: null,
    updatedAt: new Date(1730000000000),
  };

  const igCandidate = {
    id: "cand-ig-1",
    citizenship: "uz",
    erpUid: null,
    code1c: "emp-1c-2",
    personUid: "pers-uid-2",
    chatUuid: null,
    photoPath: null,
    updatedAt: new Date(1730000000000),
  };

  // Helper to generate a valid 10x10 WebP/PNG image buffer
  async function sampleImageBuffer(): Promise<Buffer> {
    return sharp({
      create: {
        width: 10,
        height: 10,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  function createMocks() {
    const tx = {
      candidate: {
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const prisma = {
      candidate: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (cb) => cb(tx)),
    };

    const storage = {
      exists: vi.fn(),
      read: vi.fn(),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
    };

    const erpWorkspace = {
      fetchCandidatePhoto: vi.fn(),
      uploadCandidatePhoto: vi.fn().mockResolvedValue({ success: true }),
    };

    const audit = {
      logInTransaction: vi.fn().mockResolvedValue(undefined),
    };

    const service = new CandidatePhotosService(
      prisma as any,
      storage as any,
      erpWorkspace as any,
      audit as any,
    );

    const controller = new CandidatePhotosController(service);

    return { prisma, tx, storage, erpWorkspace, audit, service, controller };
  }

  describe("CandidatePhotosService.getPhoto", () => {
    it("returns null if candidate does not exist", async () => {
      const { prisma, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(null);

      const result = await service.getPhoto("missing-cand");
      expect(result).toBeNull();
    });

    it("returns S3 cached photo if already exists in storage", async () => {
      const { prisma, storage, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);
      storage.exists.mockResolvedValue(true);
      const mockBuf = Buffer.from("existing-webp-bytes");
      storage.read.mockResolvedValue(mockBuf);

      const result = await service.getPhoto("cand-ru-1", "thumb");
      expect(result).not.toBeNull();
      expect(result?.buffer).toBe(mockBuf);
      expect(result?.contentType).toBe("image/webp");
      expect(result?.etag).toBe(`W/"${ruCandidate.updatedAt.getTime()}"`);
      expect(storage.read).toHaveBeenCalledWith("candidates/cand-ru-1/thumb.webp");
    });

    it("lazy loads photo from 1C ERP if storage is missing, caches in S3, and updates MariaDB", async () => {
      const { prisma, storage, erpWorkspace, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);
      storage.exists.mockResolvedValue(false);

      const rawImg = await sampleImageBuffer();
      erpWorkspace.fetchCandidatePhoto.mockResolvedValue({
        buffer: rawImg,
        contentType: "image/png",
      });

      const result = await service.getPhoto("cand-ru-1", "full");
      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("image/webp");
      expect(erpWorkspace.fetchCandidatePhoto).toHaveBeenCalledWith({
        candidate: "erp-cand-1",
      });
      expect(storage.uploadBuffer).toHaveBeenCalledWith(
        "candidates/cand-ru-1/avatar.webp",
        expect.any(Buffer),
        "image/webp",
      );
      expect(storage.uploadBuffer).toHaveBeenCalledWith(
        "candidates/cand-ru-1/thumb.webp",
        expect.any(Buffer),
        "image/webp",
      );
      expect(prisma.candidate.update).toHaveBeenCalledWith({
        where: { id: "cand-ru-1" },
        data: { photoPath: expect.stringContaining("/api/v1/candidates/cand-ru-1/photo?v=") },
      });
    });

    it("coalesces concurrent requests for the same candidate so ERP is called only once", async () => {
      const { prisma, storage, erpWorkspace, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);
      storage.exists.mockResolvedValue(false);

      const rawImg = await sampleImageBuffer();
      erpWorkspace.fetchCandidatePhoto.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { buffer: rawImg, contentType: "image/jpeg" };
      });

      const [r1, r2] = await Promise.all([
        service.getPhoto("cand-ru-1", "thumb"),
        service.getPhoto("cand-ru-1", "full"),
      ]);

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(erpWorkspace.fetchCandidatePhoto).toHaveBeenCalledTimes(1);
    });

    it("returns null if 1C ERP has no photo", async () => {
      const { prisma, storage, erpWorkspace, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(igCandidate);
      storage.exists.mockResolvedValue(false);
      erpWorkspace.fetchCandidatePhoto.mockResolvedValue(null);

      const result = await service.getPhoto("cand-ig-1");
      expect(result).toBeNull();
      expect(erpWorkspace.fetchCandidatePhoto).toHaveBeenCalledWith({
        personUid: "pers-uid-2",
        code1c: "emp-1c-2",
      });
    });
  });

  describe("CandidatePhotosService.uploadPhoto", () => {
    it("throws NotFoundException if candidate not found", async () => {
      const { prisma, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(null);

      const img = await sampleImageBuffer();
      await expect(
        service.uploadPhoto("missing", img, ruPrincipal),
      ).rejects.toThrow(NotFoundException);
    });

    it("forbids RU reviewer (20002) from uploading for IG candidate", async () => {
      const { prisma, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(igCandidate);

      const img = await sampleImageBuffer();
      await expect(
        service.uploadPhoto("cand-ig-1", img, ruPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it("forbids IG reviewer (20011) from uploading for RU candidate", async () => {
      const { prisma, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);

      const img = await sampleImageBuffer();
      await expect(
        service.uploadPhoto("cand-ru-1", img, igPrincipal),
      ).rejects.toThrow(ForbiddenException);
    });

    it("allows RU reviewer (20002) to upload photo for RU candidate", async () => {
      const { prisma, tx, storage, erpWorkspace, audit, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);

      const img = await sampleImageBuffer();
      const res = await service.uploadPhoto("cand-ru-1", img, ruPrincipal);

      expect(res.photoPath).toContain("/api/v1/candidates/cand-ru-1/photo?v=");
      expect(erpWorkspace.uploadCandidatePhoto).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: "erp-cand-1",
          actor: "emp-ru",
          extension: "webp",
        }),
        expect.any(Buffer),
      );
      expect(storage.uploadBuffer).toHaveBeenCalledWith(
        "candidates/cand-ru-1/avatar.webp",
        expect.any(Buffer),
        "image/webp",
      );
      expect(storage.uploadBuffer).toHaveBeenCalledWith(
        "candidates/cand-ru-1/thumb.webp",
        expect.any(Buffer),
        "image/webp",
      );
      expect(tx.candidate.update).toHaveBeenCalledWith({
        where: { id: "cand-ru-1" },
        data: { photoPath: res.photoPath },
      });
      expect(audit.logInTransaction).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          action: "DOCUMENT_FIELDS_UPDATED",
          entityType: "Candidate",
          entityId: "cand-ru-1",
          after: { photoPath: res.photoPath },
        }),
      );
    });

    it("allows IG reviewer (20011) to upload photo for IG candidate", async () => {
      const { prisma, erpWorkspace, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(igCandidate);

      const img = await sampleImageBuffer();
      const res = await service.uploadPhoto("cand-ig-1", img, igPrincipal);

      expect(res.photoPath).toContain("/api/v1/candidates/cand-ig-1/photo?v=");
      expect(erpWorkspace.uploadCandidatePhoto).toHaveBeenCalledWith(
        expect.objectContaining({
          personUid: "pers-uid-2",
          code1c: "emp-1c-2",
          actor: "emp-ig",
          extension: "webp",
        }),
        expect.any(Buffer),
      );
    });

    it("allows admin (20009) to upload for both RU and IG candidates", async () => {
      const { prisma, service } = createMocks();
      const img = await sampleImageBuffer();

      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);
      await expect(service.uploadPhoto("cand-ru-1", img, adminPrincipal)).resolves.toBeDefined();

      prisma.candidate.findFirst.mockResolvedValue(igCandidate);
      await expect(service.uploadPhoto("cand-ig-1", img, adminPrincipal)).resolves.toBeDefined();
    });

    it("rejects corrupted/invalid non-image files with BadRequestException", async () => {
      const { prisma, service } = createMocks();
      prisma.candidate.findFirst.mockResolvedValue(ruCandidate);

      const invalidBytes = Buffer.from("this is definitely not an image");
      await expect(
        service.uploadPhoto("cand-ru-1", invalidBytes, ruPrincipal),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("CandidatePhotosController", () => {
    it("GET: throws NotFoundException when photo does not exist", async () => {
      const { controller, service } = createMocks();
      vi.spyOn(service, "getPhoto").mockResolvedValue(null);

      const req = { headers: {} } as any;
      const reply = {
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as any;

      await expect(
        controller.getPhoto("missing-cand", {}, req, reply),
      ).rejects.toThrow(NotFoundException);
    });

    it("GET: returns 304 if If-None-Match matches ETag", async () => {
      const { controller, service } = createMocks();
      vi.spyOn(service, "getPhoto").mockResolvedValue({
        buffer: Buffer.from("bytes"),
        contentType: "image/webp",
        etag: 'W/"12345"',
        updatedAt: new Date(),
      });

      const req = { headers: { "if-none-match": 'W/"12345"' } } as any;
      const reply = {
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as any;

      await controller.getPhoto("cand-1", {}, req, reply);
      expect(reply.status).toHaveBeenCalledWith(304);
      expect(reply.send).toHaveBeenCalled();
    });

    it("GET: returns 200 with Cache-Control and photo buffer", async () => {
      const { controller, service } = createMocks();
      const mockBuf = Buffer.from("bytes");
      vi.spyOn(service, "getPhoto").mockResolvedValue({
        buffer: mockBuf,
        contentType: "image/webp",
        etag: 'W/"12345"',
        updatedAt: new Date(),
      });

      const req = { headers: {} } as any;
      const reply = {
        status: vi.fn().mockReturnThis(),
        header: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      } as any;

      await controller.getPhoto("cand-1", { size: "thumb" }, req, reply);
      expect(reply.header).toHaveBeenCalledWith("Content-Type", "image/webp");
      expect(reply.header).toHaveBeenCalledWith("ETag", 'W/"12345"');
      expect(reply.header).toHaveBeenCalledWith(
        "Cache-Control",
        "public, max-age=86400, stale-while-revalidate=604800",
      );
      expect(reply.send).toHaveBeenCalledWith(mockBuf);
    });

    it("POST: throws BadRequestException if request is not multipart", async () => {
      const { controller } = createMocks();
      const req = {
        isMultipart: () => false,
      } as any;

      await expect(
        controller.uploadPhoto("cand-1", req, ruPrincipal),
      ).rejects.toThrow(BadRequestException);
    });

    it("POST: parses file and delegates to service.uploadPhoto", async () => {
      const { controller, service } = createMocks();
      const img = await sampleImageBuffer();

      vi.spyOn(service, "uploadPhoto").mockResolvedValue({
        photoPath: "/api/v1/candidates/cand-1/photo?v=9999",
      });

      const fileStream = (async function* () {
        yield img;
      })();

      const req = {
        isMultipart: () => true,
        parts: () =>
          (async function* () {
            yield {
              type: "file",
              file: fileStream,
            };
          })(),
      } as any;

      const res = await controller.uploadPhoto("cand-1", req, ruPrincipal);
      expect(res).toEqual({
        success: true,
        photoPath: "/api/v1/candidates/cand-1/photo?v=9999",
      });
      expect(service.uploadPhoto).toHaveBeenCalledWith(
        "cand-1",
        img,
        ruPrincipal,
      );
    });
  });
});
