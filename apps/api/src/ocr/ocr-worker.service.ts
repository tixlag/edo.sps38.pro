import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { DocumentUploadService } from "../documents/document-upload.service";
import {
  OcrService,
  validateOcrResult,
  type OcrRequest,
  type OcrResult,
} from "./ocr.service";
import { OcrQueueService } from "./ocr-queue.service";

const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const FINAL = ["SUCCEEDED", "REJECTED", "FAILED"] as const;

@Injectable()
export class OcrWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OcrWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private tickPromise?: Promise<void>;
  private stopped = false;
  private lastCacheCleanup = 0;
  private readonly active = new Set<Promise<void>>();
  private readonly aborts = new Set<AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OcrQueueService,
    private readonly ocr: OcrService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Export/codegen processes must not run consumers or dispatch jobs.
    if (this.config.get<string>("OCR_WORKER_ENABLED") === "false") return;
    this.queue.setHandler((id) => {
      if (this.stopped) return Promise.reject(new Error("Worker stopping"));
      const promise = this.process(id).finally(() =>
        this.active.delete(promise),
      );
      this.active.add(promise);
      return promise;
    });
    this.timer = setInterval(() => {
      if (this.tickPromise || this.stopped) return;
      this.tickPromise = this.tick()
        .catch(() =>
          this.logger.warn("OCR maintenance unavailable; will retry"),
        )
        .finally(() => {
          this.tickPromise = undefined;
        });
    }, 2000);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    await this.recover();
    await this.cleanup().catch(() =>
      this.logger.warn("OCR file cleanup deferred; will retry"),
    );
    if (Date.now() - this.lastCacheCleanup > 600_000) {
      await new DocumentUploadService().cleanupCache();
      this.lastCacheCleanup = Date.now();
    }
    if (!this.ocr.isAvailable()) return;
    await this.queue.ensureConnected();
    const now = new Date();
    const entries = await this.prisma.ocrOutbox.findMany({
      where: {
        availableAt: { lte: now },
        OR: [
          { publishedAt: null },
          { publishedAt: { lt: new Date(Date.now() - LEASE_MS) } },
        ],
        AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }],
        job: { status: "QUEUED" },
      },
      orderBy: { availableAt: "asc" },
      take: 10,
    });
    for (const entry of entries) {
      if (this.stopped) break;
      const token = randomUUID();
      const claim = await this.prisma.ocrOutbox.updateMany({
        where: {
          id: entry.id,
          publishedAt: entry.publishedAt,
          availableAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
          job: { status: "QUEUED" },
        },
        data: { leaseToken: token, leaseUntil: new Date(Date.now() + 30_000) },
      });
      if (!claim.count) continue;
      try {
        const confirmed = await this.queue.publish(entry.jobId);
        await this.prisma.ocrOutbox.updateMany({
          where: { id: entry.id, leaseToken: token },
          data: {
            leaseToken: null,
            leaseUntil: null,
            ...(confirmed
              ? { publishedAt: new Date() }
              : { availableAt: new Date(Date.now() + 5000) }),
          },
        });
      } catch {
        await this.prisma.ocrOutbox.updateMany({
          where: { id: entry.id, leaseToken: token },
          data: {
            leaseToken: null,
            leaseUntil: null,
            availableAt: new Date(Date.now() + 5000),
          },
        });
        throw new Error("OCR publish unavailable");
      }
    }
  }

  async process(jobId: string): Promise<void> {
    const token = randomUUID();
    const claimed = await this.prisma.ocrJob.updateMany({
      where: {
        id: jobId,
        status: "QUEUED",
        attempts: { lt: MAX_ATTEMPTS },
        outbox: { availableAt: { lte: new Date() } },
      },
      data: {
        status: "RUNNING",
        leaseToken: token,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (!claimed.count) return; // Terminal or duplicate delivery; DB recovery owns abandoned leases.
    const job = await this.prisma.ocrJob.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        version: {
          include: {
            files: { orderBy: { ordinal: "asc" } },
            document: { include: { documentType: true } },
          },
        },
      },
    });
    const controller = new AbortController();
    this.aborts.add(controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const request: OcrRequest = {
        jobId,
        documentId: job.version.documentId,
        version: job.version.version,
        documentTypeCode: job.version.document.documentType?.code ?? "",
        files: await Promise.all(
          job.version.files.map(async (f) => ({
            id: f.id,
            ordinal: f.ordinal,
            mimeType: f.mimeType,
            pageCount: f.pageCount,
            downloadUrl: await this.storage.downloadUrl(
              f.storageKey,
              f.filename,
            ),
          })),
        ),
      };
      // Bound the caller even if an adapter fails to cooperate with AbortSignal.
      const result = await this.withAbort(
        this.ocr.recognize(request, controller.signal),
        controller.signal,
      );
      const checked = validateOcrResult(result, request.files);
      const raw = JSON.stringify(checked.raw);
      if (!raw || Buffer.byteLength(raw) > 2 * 1024 * 1024)
        throw new Error("OCR_CONTRACT_INVALID");
      if (checked.outcome === "REJECTED") {
        for (const issue of checked.issues) {
          const file =
            issue.fileOrdinal === null
              ? null
              : request.files.find((f) => f.ordinal === issue.fileOrdinal);
          if (
            (issue.fileOrdinal !== null && !file) ||
            (issue.pageNumber !== null &&
              (!file || issue.pageNumber > file.pageCount))
          )
            throw new Error("OCR_CONTRACT_INVALID");
        }
      }
      await this.complete(
        jobId,
        token,
        checked,
        JSON.parse(raw) as Prisma.InputJsonValue,
      );
    } catch (error) {
      const contractError =
        error instanceof Error &&
        (error.name === "ZodError" || error.message === "OCR_CONTRACT_INVALID");
      await this.failAttempt(
        jobId,
        token,
        contractError
          ? "OCR_CONTRACT_INVALID"
          : this.stopped
            ? "OCR_INTERRUPTED"
            : "OCR_UNAVAILABLE",
        contractError,
      );
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(controller);
    }
  }

  private async withAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("OCR_TIMEOUT"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async complete(
    jobId: string,
    token: string,
    result: OcrResult,
    raw: Prisma.InputJsonValue,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.ocrJob.findUnique({
        where: { id: jobId },
        include: { version: true },
      });
      if (!initial) return;
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${initial.candidateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${initial.version.documentId} FOR UPDATE`;
      const changed = await tx.ocrJob.updateMany({
        where: {
          id: jobId,
          status: "RUNNING",
          leaseToken: token,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: result.outcome,
          cleanupPending: result.outcome === "REJECTED",
          leaseToken: null,
          leaseUntil: null,
          errorCode: null,
        },
      });
      if (!changed.count) return;
      const status =
        result.outcome === "SUCCEEDED" ? "IN_REVIEW" : "OCR_FAILED";
      await tx.documentVersion.update({
        where: { id: initial.versionId },
        data: {
          status,
          ocrRaw: raw,
          ocrSource: result.source,
          revision: { increment: 1 },
        },
      });
      if (result.outcome === "SUCCEEDED") {
        await tx.documentVersionField.createMany({
          data: Object.entries(result.fields).map(([name, value]) => ({
            versionId: initial.versionId,
            name,
            originalValue: value,
            value,
          })),
        });
        if (result.regions?.length) {
          const [fields, files] = await Promise.all([
            tx.documentVersionField.findMany({
              where: { versionId: initial.versionId },
              select: { id: true, name: true },
            }),
            tx.documentVersionFile.findMany({
              where: { versionId: initial.versionId },
              select: { id: true, ordinal: true, pageCount: true },
            }),
          ]);
          const regions = result.regions.map((region) => {
            const field = fields.find((item) => item.name === region.fieldName);
            const file = files.find(
              (item) => item.ordinal === region.fileOrdinal,
            );
            if (!field || !file || region.pageNumber > file.pageCount)
              throw new Error("OCR_CONTRACT_INVALID");
            return {
              fieldId: field.id,
              fileId: file.id,
              pageNumber: region.pageNumber,
              x: region.x,
              y: region.y,
              width: region.width,
              height: region.height,
              text: region.text ?? null,
            };
          });
          await tx.ocrRegion.createMany({ data: regions });
        }
      } else {
        await tx.ocrIssue.createMany({
          data: result.issues.map((issue) => ({
            versionId: initial.versionId,
            ...issue,
          })),
        });
      }
      await tx.document.updateMany({
        where: {
          id: initial.version.documentId,
          currentVersion: initial.version.version,
        },
        data: { status },
      });
      await this.audit.logInTransaction(tx, {
        action: "DOCUMENT_OCR_COMPLETED",
        entityType: "Document",
        entityId: initial.version.documentId,
        correlationId: initial.correlationId,
        after: {
          version: initial.version.version,
          outcome: result.outcome,
          source: result.source,
        },
      });
    });
  }

  async failAttempt(
    jobId: string,
    token: string,
    code: string,
    permanent = false,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.ocrJob.findUnique({
        where: { id: jobId },
        include: { version: true },
      });
      if (!job) return;
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${job.candidateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${job.version.documentId} FOR UPDATE`;
      const final = permanent || job.attempts >= MAX_ATTEMPTS;
      const changed = await tx.ocrJob.updateMany({
        where: { id: jobId, status: "RUNNING", leaseToken: token },
        data: {
          status: final ? "FAILED" : "QUEUED",
          errorCode: code,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (!changed.count) return;
      if (!final) {
        await tx.ocrOutbox.update({
          where: { jobId },
          data: {
            publishedAt: null,
            leaseToken: null,
            leaseUntil: null,
            availableAt: new Date(
              Date.now() +
                Math.min(60_000, 5000 * 2 ** Math.max(0, job.attempts - 1)),
            ),
          },
        });
      } else {
        await tx.documentVersion.update({
          where: { id: job.versionId },
          data: { status: "OCR_FAILED" },
        });
        await tx.document.updateMany({
          where: {
            id: job.version.documentId,
            currentVersion: job.version.version,
          },
          data: { status: "OCR_FAILED" },
        });
        await this.audit.logInTransaction(tx, {
          action: "DOCUMENT_OCR_COMPLETED",
          entityType: "Document",
          entityId: job.version.documentId,
          correlationId: job.correlationId,
          after: {
            version: job.version.version,
            outcome: "FAILED",
            errorCode: code,
          },
        });
      }
    });
  }

  private async recover(): Promise<void> {
    const expired = await this.prisma.ocrJob.findMany({
      where: {
        status: { in: ["UPLOADING", "RUNNING"] },
        leaseUntil: { lt: new Date() },
      },
      take: 20,
    });
    for (const job of expired) {
      if (job.status === "RUNNING") {
        await this.failAttempt(
          job.id,
          job.leaseToken ?? "",
          "OCR_LEASE_EXPIRED",
        );
      } else {
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.ocrJob.updateMany({
            where: {
              id: job.id,
              status: "UPLOADING",
              leaseToken: job.leaseToken,
              leaseUntil: { lt: new Date() },
            },
            data: {
              status: "FAILED",
              cleanupPending: true,
              errorCode: "UPLOAD_FAILED",
              leaseToken: null,
              leaseUntil: null,
            },
          });
          if (!changed.count) return;
          const version = await tx.documentVersion.update({
            where: { id: job.versionId },
            data: { status: "OCR_FAILED" },
          });
          await this.audit.logInTransaction(tx, {
            action: "DOCUMENT_OCR_COMPLETED",
            entityType: "Document",
            entityId: version.documentId,
            correlationId: job.correlationId,
            after: { version: version.version, errorCode: "UPLOAD_FAILED" },
          });
        });
      }
    }
  }

  async cleanup(): Promise<void> {
    const jobs = await this.prisma.ocrJob.findMany({
      where: { cleanupPending: true, status: { in: [...FINAL] } },
      include: { version: { include: { files: true } } },
      take: 10,
    });
    for (const job of jobs) {
      for (const file of job.version.files) {
        if (file.deletedAt) continue;
        // Originals are never deleted before the rejection/failure transaction committed.
        await this.storage.delete(file.storageKey);
        await this.prisma.documentVersionFile.update({
          where: { id: file.id },
          data: { deletedAt: new Date() },
        });
      }
      await this.prisma.ocrJob.update({
        where: { id: job.id },
        data: { cleanupPending: false },
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const abort of this.aborts) abort.abort();
    await Promise.allSettled([
      ...this.active,
      ...(this.tickPromise ? [this.tickPromise] : []),
    ]);
  }
}
