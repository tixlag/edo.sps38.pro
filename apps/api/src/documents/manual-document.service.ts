import {
  BadRequestException,
  ConflictException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma, type DocumentStatus } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { resolveOcrProfile } from "../ocr/ocr-profile";
import { createHash, randomUUID } from "node:crypto";
import { assertDocumentUploadAllowed } from "./document-upload-policy";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { DocumentCatalogService } from "./document-catalog.service";
import {
  applicable,
  shouldOmitPositionUid,
  textValue,
  validateFields,
} from "./document-contract";
import { snapshotUpdateInput } from "./candidate-profile";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "./candidate-identity";
import { ErpCandidateClient } from "./erp-candidate.client";
import type { StagedUpload } from "./document-upload.service";

@Injectable()
export class ManualDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly catalog: DocumentCatalogService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly erp?: ErpCandidateClient,
  ) {}

  async upload(
    upload: StagedUpload,
    key: string | undefined,
    correlationId: string,
  ) {
    const metadata = upload.metadata;
    if (!metadata) throw new BadRequestException("metadata is required");
    if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new BadRequestException("Idempotency-Key is required");
    const identityKey = metadata.chat_uuid
      ? `chat:${metadata.chat_uuid}`
      : `employee:${metadata.code_1c}`;
    // erpUid was added as a trusted resolver hint. It must not change existing
    // receipt fingerprints when an old context is refreshed after deployment.
    const fingerprintSnapshot = metadata.candidateSnapshot
      ? { ...metadata.candidateSnapshot }
      : undefined;
    if (fingerprintSnapshot) {
      delete fingerprintSnapshot.erpUid;
      delete fingerprintSnapshot.personUid;
      delete fingerprintSnapshot.reviewGroup;
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          metadata: {
            ...metadata,
            ...(fingerprintSnapshot
              ? { candidateSnapshot: fingerprintSnapshot }
              : {}),
            documentFields: Object.fromEntries(
              Object.entries(metadata.documentFields).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ),
          },
          files: upload.files.map((file) => ({
            filename: file.source?.filename ?? file.filename,
            mimeType: file.source?.mimeType ?? file.mimeType,
            sha256: file.source?.sha256 ?? file.sha256,
            pageCount: file.pageCount,
          })),
        }),
      )
      .digest("hex");
    const previous = await this.prisma.documentSubmission.findUnique({
      where: {
        identityKey_idempotencyKey: { identityKey, idempotencyKey: key },
      },
      include: { version: { include: { document: true } } },
    });
    if (!this.erp)
      throw new ServiceUnavailableException("CANDIDATE_IDENTITY_UNAVAILABLE");
    let erpUid: string | undefined, personUid: string | undefined;
    let reviewGroup: "RU" | "IG";
    let canonicalChat = metadata.chat_uuid;
    if (metadata.code_1c) {
      const identity = await this.erp.resolveCurrentIdentity(metadata.code_1c);
      erpUid = identity.erpUid ?? undefined;
      personUid = identity.personUid ?? undefined;
      reviewGroup = identity.reviewGroup;
      if (metadata.chat_uuid && metadata.chat_uuid !== identity.chatUuid)
        throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
      canonicalChat = identity.chatUuid ?? undefined;
    } else {
      erpUid = await this.erp.resolveIdentityByChat(metadata.chat_uuid!);
      if (!erpUid)
        throw new ServiceUnavailableException("CANDIDATE_IDENTITY_UNAVAILABLE");
      reviewGroup = "RU"; // ERP candidate business object, not inferred from chat presence.
    }
    const canonicalKey = erpUid ? `erp:${erpUid}` : `person:${personUid}`;
    if (previous) {
      const result = this.reuse(previous, fingerprint);
      const expectedErpUid = erpUid;
      if (expectedErpUid) {
        const owners = await this.prisma.candidate.findMany({
          where: {
            OR: [{ id: result.candidateId }, { erpUid: expectedErpUid }],
          },
        });
        if (
          owners.length !== 1 ||
          (owners[0].erpUid && owners[0].erpUid !== expectedErpUid)
        )
          throw new ConflictException("CANDIDATE_IDENTITY_CONFLICT");
      }
      await candidateIdentityTransaction(this.prisma, async (tx) => {
        const before = await tx.candidate.findUniqueOrThrow({
          where: { id: result.candidateId },
        });
        const previousOwner = await resolveCandidateIdentity(tx, {
          identityKey: canonicalKey,
          expectedId: result.candidateId,
          erpUid,
          chatUuid: canonicalChat,
          personUid,
          reviewGroup,
          code1c: metadata.code_1c,
        });
        if (
          previousOwner.code1c &&
          metadata.code_1c &&
          previousOwner.code1c !== metadata.code_1c
        )
          throw new ConflictException("CANDIDATE_IDENTITY_CHANGED");
        if (
          before.erpUid !== previousOwner.erpUid ||
          before.personUid !== previousOwner.personUid ||
          before.reviewGroup !== previousOwner.reviewGroup
        )
          await this.audit.logInTransaction(tx, {
            actorId: "lk-service",
            action: "CANDIDATE_LINKED",
            entityType: "Candidate",
            entityId: previousOwner.id,
            correlationId,
            after: {
              erpUid: previousOwner.erpUid,
              personUid: previousOwner.personUid,
              reviewGroup: previousOwner.reviewGroup,
            },
          });
      });
      return result;
    }
    await this.catalog.ensure();
    const type = await this.prisma.documentType.findUnique({
      where: { erpUid: metadata.documentUid },
      include: { definitions: true, positions: true },
    });
    if (
      !type?.catalogSyncedAt ||
      !applicable(type, metadata.position_code_1c, metadata.citizenship)
    )
      throw new BadRequestException(
        "Document type is unavailable for this candidate",
      );
    const fields = { ...metadata.documentFields };
    if (shouldOmitPositionUid(fields.positionUid, metadata.position_code_1c))
      delete fields.positionUid;
    validateFields(type.definitions, fields);
    let locationId = metadata.locationId;
    if (
      locationId !== undefined &&
      !(await this.prisma.lkLocation.findFirst({
        where: { locationId, deleted: false },
      }))
    )
      throw new BadRequestException("Unknown or deleted locationId");
    if (locationId === undefined && metadata.project_code_1c)
      locationId = (
        await this.prisma.lkLocation.findFirst({
          where: { code1c: metadata.project_code_1c, deleted: false },
        })
      )?.locationId;
    const token = randomUUID();
    const correlation = correlationId.slice(0, 64);
    const reserved = await this.reserve(
      identityKey,
      key,
      fingerprint,
      token,
      type.id,
      type.definitions,
      fields,
      upload,
      locationId,
      correlation,
      erpUid,
      canonicalKey,
      canonicalChat,
      personUid,
      reviewGroup,
    );
    if (reserved.reused) return this.reuse(reserved.submission, fingerprint);
    const signal = AbortSignal.timeout(120000);
    try {
      for (const file of reserved.submission.version.files) {
        const staged = upload.files[file.ordinal];
        await this.storage.upload(
          file.storageKey,
          staged.path,
          staged.mimeType,
          staged.sizeBytes,
          signal,
        );
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${reserved.submission.version.document.candidateId} FOR UPDATE`;
        const changed = await tx.documentSubmission.updateMany({
          where: {
            id: reserved.submission.id,
            leaseToken: token,
            status: "UPLOADING",
          },
          data: { status: "SUCCEEDED", leaseUntil: null, leaseToken: null },
        });
        if (changed.count !== 1)
          throw new ConflictException("Upload lease expired");
        await tx.documentVersion.update({
          where: { id: reserved.submission.versionId },
          data: { status: "IN_REVIEW", submittedAt: new Date() },
        });
        const profile = resolveOcrProfile({
          documentUid: metadata.documentUid,
          documentTypeCode: type.code,
          citizenship: metadata.citizenship,
        });
        if (
          profile &&
          this.config?.get("OCR_MODE") === "external" &&
          this.config.get("OCR_WORKER_ENABLED") !== "false"
        ) {
          await tx.ocrJob.create({
            data: {
              versionId: reserved.submission.versionId,
              candidateId: reserved.submission.version.document.candidateId!,
              idempotencyKey: `submission:${reserved.submission.id}`,
              fingerprint,
              correlationId: correlation,
              status: "QUEUED",
              outbox: { create: {} },
            },
          });
        }
        await tx.document.updateMany({
          where: {
            id: reserved.submission.version.documentId,
            currentVersion: { lt: reserved.submission.version.version },
          },
          data: {
            currentVersion: reserved.submission.version.version,
            status: "IN_REVIEW",
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: "lk-service",
          action: "DOCUMENT_UPLOADED",
          entityType: "Document",
          entityId: reserved.submission.version.documentId,
          correlationId: correlation,
          after: {
            version: reserved.submission.version.version,
            source: "MANUAL",
            fileCount: upload.files.length,
            ...(upload.files.some((f) => f.source)
              ? {
                  normalization: "heic-webp-v1",
                  normalizedFileCount: upload.files.filter((f) => f.source)
                    .length,
                }
              : {}),
          },
        });
      });
      return this.accepted(reserved.submission);
    } catch (error) {
      await this.fail(reserved.submission.id, token);
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("UPLOAD_FAILED");
    }
  }

  private async reserve(
    identityKey: string,
    key: string,
    fingerprint: string,
    token: string,
    typeId: string,
    definitions: {
      name: string;
      kind: string;
      required: boolean;
      ordinal: number;
    }[],
    fields: Record<string, string | boolean | null>,
    upload: StagedUpload,
    locationId: number | undefined,
    correlationId: string,
    erpUid?: string,
    canonicalKey?: string,
    canonicalChat?: string,
    personUid?: string,
    reviewGroup?: "RU" | "IG",
  ) {
    const metadata = upload.metadata!;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // LK profile snapshot: only keys actually present in the upload
            // update the stored profile; uploads without a snapshot (or with
            // an empty one) never clear previously stored fields.
            const profile = snapshotUpdateInput(metadata.candidateSnapshot);
            const owner = await resolveCandidateIdentity(tx, {
              identityKey: canonicalKey ?? identityKey,
              chatUuid: canonicalChat,
              erpUid,
              personUid,
              reviewGroup,
              code1c: metadata.code_1c,
            });
            if (profile)
              await tx.candidate.update({
                where: { id: owner.id },
                data: profile,
              });
            await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${owner.id} FOR UPDATE`;
            const current = await tx.candidate.findUniqueOrThrow({
              where: { id: owner.id },
            });
            if (
              current.code1c &&
              metadata.code_1c &&
              current.code1c !== metadata.code_1c
            )
              throw new ConflictException(
                "Candidate already linked to another code1c",
              );
            if (metadata.code_1c && !current.code1c) {
              await tx.candidate.update({
                where: { id: owner.id },
                data: { code1c: metadata.code_1c },
              });
              await this.audit.logInTransaction(tx, {
                actorId: "lk-service",
                action: "CANDIDATE_LINKED",
                entityType: "Candidate",
                entityId: owner.id,
                correlationId,
                before: { code1c: null },
                after: { code1c: metadata.code_1c },
              });
            }
            const previous = await tx.documentSubmission.findUnique({
              where: {
                identityKey_idempotencyKey: {
                  identityKey,
                  idempotencyKey: key,
                },
              },
              include: {
                version: { include: { document: true, files: true } },
              },
            });
            if (previous) return { reused: true, submission: previous };
            if (locationId !== undefined && current.locationId !== locationId)
              await tx.candidate.update({
                where: { id: owner.id },
                data: { locationId },
              });
            const doc = await tx.document.upsert({
              where: {
                candidateId_documentTypeId: {
                  candidateId: owner.id,
                  documentTypeId: typeId,
                },
              },
              update: {},
              create: {
                candidateId: owner.id,
                documentTypeId: typeId,
                reviewGroup,
                currentVersion: 0,
              },
            });
            if (doc.reviewGroup && doc.reviewGroup !== reviewGroup)
              throw new ConflictException("DOCUMENT_PROCESS_CONFLICT");
            if (!doc.reviewGroup) {
              if (!erpUid || current.erpUid !== erpUid)
                throw new ConflictException(
                  "LEGACY_DOCUMENT_PROCESS_CONFIRMATION_REQUIRED",
                );
              await tx.document.update({
                where: { id: doc.id },
                data: { reviewGroup },
              });
            }
            await assertDocumentUploadAllowed(tx, doc);
            const last = await tx.documentVersion.aggregate({
              where: { documentId: doc.id },
              _max: { version: true },
            });
            const number = (last._max.version ?? 0) + 1;
            const files = upload.files.map((f) => ({
              id: f.id,
              ordinal: f.ordinal,
              storageKey: this.storage.keyFor(doc.id, number, f.id),
              filename: f.filename,
              mimeType: f.mimeType,
              sizeBytes: f.sizeBytes,
              sha256: f.sha256,
              pageCount: f.pageCount,
              ...(f.source
                ? {
                    sourceFilename: f.source.filename,
                    sourceMimeType: f.source.mimeType,
                    sourceSizeBytes: f.source.sizeBytes,
                    sourceSha256: f.source.sha256,
                    normalization: f.normalization,
                  }
                : {}),
            }));
            const version = await tx.documentVersion.create({
              data: {
                documentId: doc.id,
                version: number,
                storageKey: files[0].storageKey,
                status: "UPLOADED",
                positionCode1c: metadata.position_code_1c,
                citizenship: metadata.citizenship,
                files: { create: files },
                fields: {
                  create: definitions.map(
                    ({ name, kind, required, ordinal }) => ({
                      name,
                      kind,
                      required,
                      ordinal,
                      submittedValue: textValue(fields[name]),
                      value: textValue(fields[name]),
                    }),
                  ),
                },
              },
            });
            const submission = await tx.documentSubmission.create({
              data: {
                identityKey,
                idempotencyKey: key,
                fingerprint,
                versionId: version.id,
                leaseToken: token,
                leaseUntil: new Date(Date.now() + 600000),
              },
              include: {
                version: { include: { document: true, files: true } },
              },
            });
            await this.audit.logInTransaction(tx, {
              actorId: "lk-service",
              action: "DOCUMENT_UPLOAD_STARTED",
              entityType: "Document",
              entityId: doc.id,
              correlationId,
              after: { version: number, submissionId: submission.id },
            });
            return { reused: false, submission };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034"].includes(error.code)
        )
          continue;
        throw error;
      }
    }
  }
  private accepted(
    row: {
      id: string;
      version: {
        documentId: string;
        version: number;
        document: { candidateId: string | null };
      };
    },
    status: DocumentStatus = "IN_REVIEW",
  ) {
    return {
      candidateId: row.version.document.candidateId!,
      documentId: row.version.documentId,
      version: row.version.version,
      submissionId: row.id,
      jobId: null,
      status,
    };
  }
  private reuse(
    row: {
      id: string;
      fingerprint: string;
      status: string;
      version: {
        status: DocumentStatus;
        documentId: string;
        version: number;
        document: { candidateId: string | null };
      };
    },
    fingerprint: string,
  ) {
    if (row.fingerprint !== fingerprint)
      throw new ConflictException(
        "Idempotency-Key already used with different content",
      );
    if (row.status !== "SUCCEEDED")
      throw new ConflictException(
        row.status === "UPLOADING"
          ? "Upload is still in progress"
          : "Upload failed; use a new Idempotency-Key",
      );
    return this.accepted(row, row.version.status);
  }
  async fail(id: string, token?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.documentSubmission.findUnique({ where: { id } });
      if (!receipt) return;
      const changed = await tx.documentSubmission.updateMany({
        where: {
          id,
          status: "UPLOADING",
          ...(token
            ? { leaseToken: token }
            : { leaseUntil: { lt: new Date() } }),
        },
        data: {
          status: "FAILED",
          errorCode: "UPLOAD_FAILED",
          leaseToken: null,
          leaseUntil: null,
        },
      });
      if (changed.count) {
        const version = await tx.documentVersion.update({
          where: { id: receipt.versionId },
          data: { cleanupPending: true },
        });
        await this.audit.logInTransaction(tx, {
          actorId: "lk-service",
          action: "DOCUMENT_UPLOAD_FAILED",
          entityType: "Document",
          entityId: version.documentId,
          after: { version: version.version, errorCode: "UPLOAD_FAILED" },
        });
      }
    });
  }
}
