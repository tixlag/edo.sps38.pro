import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { StorageService } from "../storage/storage.service";
import { DocumentAccessService } from "./document-access.service";
import { FIELD_LABELS } from "./document-contract";
import type {
  CandidateDto,
  CandidateListDto,
  DocumentDto,
  DocumentListDto,
  DocumentVersionDto,
  DownloadDto,
} from "./dto/document.dto";

const versionInclude = {
  files: { orderBy: { ordinal: "asc" as const } },
  fields: {
    orderBy: [{ ordinal: "asc" as const }, { name: "asc" as const }],
    include: {
      regions: {
        include: { file: { select: { ordinal: true } } },
        orderBy: [
          { pageNumber: "asc" as const },
          { y: "asc" as const },
          { x: "asc" as const },
        ],
      },
    },
  },
  issues: true,
  job: true,
  delivery: {
    include: { attempts: { orderBy: { startedAt: "desc" as const } } },
  },
} satisfies Prisma.DocumentVersionInclude;

@Injectable()
export class DocumentReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly storage: StorageService,
  ) {}

  candidateDto(c: {
    id: string;
    chatUuid: string | null;
    locationId: number | null;
    code1c: string | null;
    createdAt: Date;
  }): CandidateDto {
    return {
      id: c.id,
      chatUuid: c.chatUuid,
      locationId: c.locationId,
      code1c: c.code1c,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async candidates(
    principal: AuthPrincipal,
    limit = 50,
    cursor?: string,
  ): Promise<CandidateListDto> {
    const rows = await this.prisma.candidate.findMany({
      where: {
        ...this.access.candidateWhere(principal),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    return {
      items: rows.slice(0, limit).map((r) => this.candidateDto(r)),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async documents(where: Prisma.DocumentWhereInput): Promise<DocumentListDto> {
    const rows = await this.prisma.document.findMany({
      where,
      include: {
        documentType: true,
        candidate: true,
        versions: {
          select: {
            version: true,
            revision: true,
            delivery: { select: { status: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map(
        (d): DocumentDto => ({
          id: d.id,
          documentTypeCode: d.documentType?.code ?? null,
          status: d.status,
          currentVersion: d.currentVersion,
          revision:
            d.versions.find((v) => v.version === d.currentVersion)?.revision ??
            0,
          title: d.documentType?.title ?? "Документ",
          documentUid: d.documentType?.erpUid ?? null,
          candidateId: d.candidateId,
          chatUuid: d.candidate?.chatUuid ?? null,
          code1c: d.candidate?.code1c ?? null,
          deliveryStatus:
            d.versions.find((v) => v.version === d.currentVersion)?.delivery
              ?.status ?? null,
          pendingDeliveryVersions: d.versions
            .filter(
              (v) =>
                v.delivery &&
                ["REQUIRES_MANUAL", "WAITING_CONTRACT"].includes(
                  v.delivery.status,
                ),
            )
            .map((v) => v.version)
            .sort((a, b) => b - a),
        }),
      ),
    };
  }

  async candidateDocuments(
    id: string,
    principal: AuthPrincipal,
  ): Promise<DocumentListDto> {
    await this.access.candidate(id, principal);
    return this.documents({
      candidateId: id,
      ...this.access.documentWhere(principal),
    });
  }

  async employeeDocuments(
    id: string,
    principal: AuthPrincipal,
  ): Promise<DocumentListDto> {
    const employee = await this.access.employee(id, principal);
    return this.documents({
      AND: [
        this.access.documentWhere(principal),
        {
          OR: [
            { employeeId: id },
            ...(employee.lkEmployeeCode1c
              ? [{ candidate: { code1c: employee.lkEmployeeCode1c } }]
              : []),
          ],
        },
      ],
    });
  }

  async version(
    documentId: string,
    version: number,
  ): Promise<DocumentVersionDto> {
    const row = await this.prisma.documentVersion.findUnique({
      where: { documentId_version: { documentId, version } },
      include: versionInclude,
    });
    if (!row) throw new NotFoundException("Document version not found");
    return {
      documentId,
      version,
      status: row.status,
      revision: row.revision,
      ocrSource: row.ocrSource,
      files: row.files.map((f) => ({
        id: f.id,
        ordinal: f.ordinal,
        filename: f.filename,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        pageCount: f.pageCount,
        deleted: f.deletedAt !== null,
      })),
      fields: row.fields.map((f) => ({
        name: f.name,
        originalValue: f.originalValue,
        value: f.value,
        editedBy: f.editedBy,
        submittedValue: f.submittedValue,
        label: FIELD_LABELS[f.name] ?? f.name,
        kind: f.kind,
        required: f.required,
        mismatch:
          f.submittedValue !== null &&
          f.originalValue !== null &&
          f.submittedValue !== f.originalValue,
        regions: f.regions.map((region) => ({
          id: region.id,
          fileId: region.fileId,
          fileOrdinal: region.file.ordinal,
          pageNumber: region.pageNumber,
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          text: region.text,
        })),
      })),
      issues: row.issues.map((i) => ({
        code: i.code,
        message: i.message,
        fileOrdinal: i.fileOrdinal,
        pageNumber: i.pageNumber,
      })),
      job: row.job
        ? {
            id: row.job.id,
            status: row.job.status,
            errorCode: row.job.errorCode,
            cleanupPending: row.job.cleanupPending,
          }
        : null,
      raw: row.ocrRaw,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedBy: row.approvedBy,
      rejectionReason: row.rejectionReason,
      delivery: row.delivery
        ? {
            status: row.delivery.status,
            errorCode: row.delivery.errorCode,
            attempts: row.delivery.attempts.map((a) => ({
              id: a.id,
              actorId: a.actorId,
              startedAt: a.startedAt.toISOString(),
              finishedAt: a.finishedAt?.toISOString() ?? null,
              errorCode: a.errorCode,
            })),
          }
        : null,
    };
  }

  async publicVersion(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
  ): Promise<DocumentVersionDto> {
    await this.access.document(documentId, principal);
    return this.version(documentId, version);
  }

  async internalVersion(
    chatUuid: string,
    documentId: string,
    version: number,
  ): Promise<DocumentVersionDto> {
    const doc = await this.prisma.document.findFirst({
      where: { id: documentId, candidate: { chatUuid } },
    });
    if (!doc)
      throw new NotFoundException("Document not found in candidate chat");
    return this.version(documentId, version);
  }

  async download(
    documentId: string,
    version: number,
    fileId: string,
    principal: AuthPrincipal,
  ): Promise<DownloadDto> {
    await this.access.document(documentId, principal);
    const file = await this.prisma.documentVersionFile.findFirst({
      where: {
        id: fileId,
        deletedAt: null,
        version: {
          documentId,
          version,
          status: { not: "RETURNED" },
          cleanupPending: false,
          OR: [{ submission: null }, { submission: { status: "SUCCEEDED" } }],
        },
        // Rejected/incomplete uploads are unavailable even while cleanup is pending.
        OR: [
          { version: { job: null } },
          {
            version: {
              job: { status: { in: ["SUCCEEDED", "QUEUED", "RUNNING"] } },
            },
          },
          {
            version: {
              job: {
                status: "FAILED",
                errorCode: { not: "UPLOAD_FAILED" },
                cleanupPending: false,
              },
            },
          },
        ],
      },
    });
    if (!file) throw new NotFoundException("Document file not available");
    return {
      url: await this.storage.downloadUrl(file.storageKey, file.filename),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async types() {
    return {
      items: await this.prisma.documentType.findMany({
        select: { code: true, title: true },
        orderBy: { code: "asc" },
      }),
    };
  }
  scopeWhere(scope: {
    chat_uuid?: string;
    code_1c?: string;
  }): Prisma.DocumentWhereInput {
    if (!scope.chat_uuid && !scope.code_1c)
      throw new BadRequestException("Document owner is required");
    return {
      candidate: {
        ...(scope.chat_uuid
          ? { chatUuid: scope.chat_uuid.toLowerCase() }
          : { code1c: scope.code_1c }),
      },
    };
  }
  async internalDocuments(scope: { chat_uuid?: string; code_1c?: string }) {
    return this.documents({
      ...this.scopeWhere(scope),
      currentVersion: { gt: 0 },
    });
  }
  async documentInfo(id: string, principal: AuthPrincipal) {
    await this.access.document(id, principal);
    return (await this.documents({ id })).items[0];
  }
  async reviewDocuments(
    principal: AuthPrincipal,
    limit = 50,
    cursor?: string,
    status?: string,
  ) {
    const where: Prisma.DocumentWhereInput = {
      ...this.access.documentWhere(principal),
      currentVersion: { gt: 0 },
      ...(cursor ? { id: { gt: cursor } } : {}),
      ...(status === "ALL"
        ? {}
        : status === "ERP_PENDING"
          ? {
              versions: {
                some: {
                  delivery: {
                    status: { in: ["REQUIRES_MANUAL", "WAITING_CONTRACT"] },
                  },
                },
              },
            }
          : { status: "IN_REVIEW" }),
    };
    const rows = await this.prisma.document.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const ids = rows.slice(0, limit).map((r) => r.id);
    const documents = await this.documents({ id: { in: ids } });
    return {
      items: ids.map((id) => documents.items.find((d) => d.id === id)!),
      nextCursor: rows.length > limit ? ids[ids.length - 1] : null,
    };
  }
}
