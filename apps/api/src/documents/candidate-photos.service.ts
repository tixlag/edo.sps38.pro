import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ErpWorkspaceClient } from "./erp-workspace.client";
import { AuditService } from "../audit/audit.service";
import { candidateReviewGroup, requireReviewGroup } from "./review-group";
import type { AuthPrincipal } from "../auth/auth-principal";
import { isHeic, normalizeHeic } from "./heic-normalization";

interface PhotoResult {
  buffer: Buffer;
  contentType: string;
  etag: string;
  updatedAt: Date;
}

interface LoadedErpPhoto {
  fullBuffer: Buffer;
  thumbBuffer: Buffer;
  version: number;
}

@Injectable()
export class CandidatePhotosService {
  private readonly inflightRequests = new Map<string, Promise<LoadedErpPhoto | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly erpWorkspace: ErpWorkspaceClient,
    private readonly audit: AuditService,
  ) {}

  keyFor(candidateId: string, size: "full" | "thumb"): string {
    return size === "thumb"
      ? `candidates/${candidateId}/thumb.webp`
      : `candidates/${candidateId}/avatar.webp`;
  }

  async getPhoto(
    candidateId: string,
    size: "full" | "thumb" = "thumb",
  ): Promise<PhotoResult | null> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { OR: [{ id: candidateId }, { chatUuid: candidateId }] },
    });
    if (!candidate) return null;

    const targetKey = this.keyFor(candidate.id, size);
    if (await this.storage.exists(targetKey)) {
      try {
        const buffer = await this.storage.read(targetKey);
        return {
          buffer,
          contentType: "image/webp",
          etag: `W/"${candidate.updatedAt.getTime()}"`,
          updatedAt: candidate.updatedAt,
        };
      } catch {
        // If read fails, fallback to lazy load from ERP below
      }
    }

    let inflight = this.inflightRequests.get(candidate.id);
    if (!inflight) {
      inflight = this.loadFromErpAndCache(candidate);
      this.inflightRequests.set(candidate.id, inflight);
      inflight.finally(() => this.inflightRequests.delete(candidate.id));
    }

    const loaded = await inflight;
    if (!loaded) return null;

    const buffer = size === "thumb" ? loaded.thumbBuffer : loaded.fullBuffer;
    return {
      buffer,
      contentType: "image/webp",
      etag: `W/"${loaded.version}"`,
      updatedAt: new Date(loaded.version),
    };
  }

  private async loadFromErpAndCache(candidate: {
    id: string;
    erpUid: string | null;
    personUid: string | null;
    code1c: string | null;
    chatUuid: string | null;
    citizenship: string | null;
  }): Promise<LoadedErpPhoto | null> {
    const group = candidateReviewGroup(candidate);
    const target: { candidate?: string; personUid?: string; code1c?: string } = {};

    if (group === "RU" || candidate.erpUid) {
      target.candidate = candidate.erpUid ?? undefined;
    }
    if (group === "IG" || !target.candidate) {
      target.personUid = candidate.personUid ?? undefined;
      target.code1c = candidate.code1c ?? undefined;
    }

    if (!target.candidate && !target.personUid && !target.code1c) {
      return null;
    }

    let erpPhoto: { buffer: Buffer; contentType: string } | null;
    try {
      erpPhoto = await this.erpWorkspace.fetchCandidatePhoto(target);
    } catch {
      return null;
    }

    if (!erpPhoto || !erpPhoto.buffer || erpPhoto.buffer.length === 0) {
      return null;
    }

    const decoded = await this.ensureDecodableBuffer(erpPhoto.buffer);
    const fullBuffer = await sharp(decoded)
      .rotate()
      .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    const thumbBuffer = await sharp(decoded)
      .rotate()
      .resize(128, 128, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();

    const fullKey = this.keyFor(candidate.id, "full");
    const thumbKey = this.keyFor(candidate.id, "thumb");

    await this.storage.uploadBuffer(fullKey, fullBuffer, "image/webp");
    await this.storage.uploadBuffer(thumbKey, thumbBuffer, "image/webp");

    const now = Date.now();
    const photoPath = `/api/v1/candidates/${candidate.id}/photo?v=${now}`;
    await this.prisma.candidate.update({
      where: { id: candidate.id },
      data: { photoPath },
    });

    return { fullBuffer, thumbBuffer, version: now };
  }

  async uploadPhoto(
    candidateId: string,
    fileBuffer: Buffer,
    principal: AuthPrincipal,
  ): Promise<{ photoPath: string }> {
    const candidate = await this.prisma.candidate.findFirst({
      where: { OR: [{ id: candidateId }, { chatUuid: candidateId }] },
    });
    if (!candidate) throw new NotFoundException("CANDIDATE_NOT_FOUND");

    const group = candidateReviewGroup(candidate);
    requireReviewGroup(principal, group);

    const decoded = await this.ensureDecodableBuffer(fileBuffer);
    let fullBuffer: Buffer;
    let thumbBuffer: Buffer;
    try {
      fullBuffer = await sharp(decoded)
        .rotate()
        .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      thumbBuffer = await sharp(decoded)
        .rotate()
        .resize(128, 128, { fit: "cover" })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      throw new BadRequestException("INVALID_IMAGE_FILE");
    }

    const target: {
      candidate?: string;
      personUid?: string;
      code1c?: string;
      actor: string;
      requestId: string;
      extension: string;
    } = {
      actor: principal.code1c || principal.uuid,
      requestId: randomUUID(),
      extension: "webp",
    };

    if (group === "RU" || candidate.erpUid) {
      target.candidate = candidate.erpUid ?? undefined;
    }
    if (group === "IG" || !target.candidate) {
      target.personUid = candidate.personUid ?? undefined;
      target.code1c = candidate.code1c ?? undefined;
    }

    await this.erpWorkspace.uploadCandidatePhoto(target, fullBuffer);

    const fullKey = this.keyFor(candidate.id, "full");
    const thumbKey = this.keyFor(candidate.id, "thumb");

    await this.storage.uploadBuffer(fullKey, fullBuffer, "image/webp");
    await this.storage.uploadBuffer(thumbKey, thumbBuffer, "image/webp");

    const now = Date.now();
    const photoPath = `/api/v1/candidates/${candidate.id}/photo?v=${now}`;

    await this.prisma.$transaction(async (tx) => {
      await tx.candidate.update({
        where: { id: candidate.id },
        data: { photoPath },
      });

      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "DOCUMENT_FIELDS_UPDATED",
        entityType: "Candidate",
        entityId: candidate.id,
        before: { photoPath: candidate.photoPath },
        after: { photoPath },
      });
    });

    return { photoPath };
  }

  private async ensureDecodableBuffer(bytes: Buffer): Promise<Buffer> {
    if (!isHeic(bytes)) return bytes;
    const tempDir = await fs.mkdtemp(join(tmpdir(), "photo-heic-"));
    const inPath = join(tempDir, "input.heic");
    const outPath = join(tempDir, "output.png");
    try {
      await fs.writeFile(inPath, bytes);
      await normalizeHeic(inPath, outPath);
      return await fs.readFile(outPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
