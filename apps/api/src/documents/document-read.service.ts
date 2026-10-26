import { requireReviewGroup, type ReviewGroup } from "./review-group";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  canRetryDocumentOcr,
  canStartDocumentOcr,
} from "../ocr/ocr-retry-policy";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { StorageService } from "../storage/storage.service";
import { DocumentAccessService } from "./document-access.service";
import { applicable, FIELD_LABELS } from "./document-contract";
import {
  normalizeRussianPassportSeries,
  resolveOcrProfile,
} from "../ocr/ocr-profile";
import {
  buildCandidateProfileWhere,
  toCandidateProfile,
} from "./candidate-profile";
import type {
  CandidateDocumentDraftDto,
  CandidateDetailsDto,
  CandidateDocumentSummaryDto,
  CandidateProfileDto,
  CandidateReviewQueueDto,
  CandidateReviewQueueQueryDto,
  CandidateDto,
  CandidateListDto,
  DocumentDto,
  DocumentListDto,
  DocumentVersionDto,
  DocumentOcrDetailsDto,
  DownloadDto,
  PositionListDto,
  ReviewCandidateListDto,
  ReviewCandidatesQueryDto,
  ReviewDocumentFacetsDto,
  ReviewDocumentsQueryDto,
} from "./dto/document.dto";

const documentSummaryInclude = {
  documentType: true,
  versions: {
    select: {
      version: true,
      revision: true,
      status: true,
      rejectionReason: true,
      submittedAt: true,
      reviewedAt: true,
      reviewedBy: true,
      job: { select: { status: true, errorCode: true } },
      delivery: { select: { status: true } },
    },
  },
} satisfies Prisma.DocumentInclude;

const versionInclude = {
  document: { include: { documentType: true, candidate: true } },
  submission: { select: { id: true, status: true } },
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
  ocrFields: { orderBy: { ordinal: "asc" as const } },
  job: true,
  delivery: {
    include: { attempts: { orderBy: { startedAt: "desc" as const } } },
  },
} satisfies Prisma.DocumentVersionInclude;

function comparableDate(value: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const localized = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(value);
  const match = iso ?? localized;
  if (!match) return null;

  const [, first, second, third] = match;
  const year = Number(iso ? first : third);
  const month = Number(second);
  const day = Number(iso ? third : first);
  if (year < 1 || month < 1 || month > 12) return null;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) return null;

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function ocrValuesMatch(
  candidateValue: string,
  ocrValue: string,
  field: { name: string; kind: string },
  isRussianPassport: boolean,
): boolean {
  if (candidateValue === ocrValue) return true;
  if (field.kind === "date") {
    const candidateDate = comparableDate(candidateValue.trim());
    const ocrDate = comparableDate(ocrValue.trim());
    return candidateDate !== null && candidateDate === ocrDate;
  }

  // Older Russian-passport OCR records may still contain spaces in the series.
  if (isRussianPassport && field.name === "series")
    return (
      normalizeRussianPassportSeries(candidateValue) ===
      normalizeRussianPassportSeries(ocrValue)
    );

  return false;
}

@Injectable()
export class DocumentReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly storage: StorageService,
    @Optional() private readonly config?: ConfigService,
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
      include: { ...documentSummaryInclude, candidate: true },
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map(
        (d): DocumentDto => ({
          ...this.documentSummary(d),
          candidateId: d.candidateId,
          chatUuid: d.candidate?.chatUuid ?? null,
          code1c: d.candidate?.code1c ?? null,
          candidate: toCandidateProfile(d.candidate),
        }),
      ),
    };
  }

  private documentSummary(
    d: Prisma.DocumentGetPayload<{ include: typeof documentSummaryInclude }>,
  ): CandidateDocumentSummaryDto {
    const current = d.versions.find((v) => v.version === d.currentVersion);
    const returned = d.versions
      .filter((v) => v.status === "RETURNED")
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        version: v.version,
        rejectionReason: v.rejectionReason,
        submittedAt: v.submittedAt?.toISOString() ?? null,
        reviewedAt: v.reviewedAt?.toISOString() ?? null,
        reviewedBy: v.reviewedBy ?? null,
        supersededByVersion:
          d.currentVersion > v.version ? d.currentVersion : null,
      }));
    return {
      ...(returned.length ? { returnedVersions: returned } : {}),
      id: d.id,
      documentTypeCode: d.documentType?.code ?? null,
      status: d.status,
      currentVersion: d.currentVersion,
      revision: current?.revision ?? 0,
      submittedAt: current?.submittedAt?.toISOString() ?? null,
      reviewedAt: current?.reviewedAt?.toISOString() ?? null,
      reviewedBy: current?.reviewedBy ?? null,
      ocrStatus: current?.job?.status ?? null,
      ocrErrorCode: current?.job?.errorCode ?? null,
      title: d.documentType?.title ?? "Документ",
      documentUid: d.documentType?.erpUid ?? null,
      deliveryStatus: current?.delivery?.status ?? null,
      pendingDeliveryVersions: d.versions
        .filter(
          (v) =>
            v.delivery &&
            ["REQUIRES_MANUAL", "WAITING_CONTRACT"].includes(v.delivery.status),
        )
        .map((v) => v.version)
        .sort((a, b) => b - a),
    };
  }

  async candidateDetails(
    id: string,
    principal: AuthPrincipal,
  ): Promise<CandidateDetailsDto> {
    const owner = await this.access.candidate(id, principal);
    const rows = await this.prisma.document.findMany({
      where: {
        candidateId: id,
        currentVersion: { gt: 0 },
        ...this.access.documentWhere(principal),
      },
      include: documentSummaryInclude,
      orderBy: { id: "asc" },
    });
    const candidate = toCandidateProfile(owner)!;
    await this.enrichReviewCandidates(principal, [candidate]);
    return {
      candidate,
      documents: rows.map((row) => this.documentSummary(row)),
    };
  }

  async candidateDocuments(
    id: string,
    principal: AuthPrincipal,
  ): Promise<DocumentListDto> {
    await this.access.candidate(id, principal);
    const documents = await this.documents({
      candidateId: id,
      ...this.access.documentWhere(principal),
    });
    await this.enrichReviewCandidates(
      principal,
      documents.items.flatMap((d) => (d.candidate ? [d.candidate] : [])),
    );
    return documents;
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
    const isRussianPassport =
      resolveOcrProfile({
        documentUid: row.document.documentType?.erpUid,
        documentTypeCode: row.document.documentType?.code ?? "",
        citizenship: row.citizenship,
      }) === "passport_ru";
    const reviewers = row.reviewedBy
      ? await this.prisma.lkEmployee.findMany({
          where: { uuid: row.reviewedBy },
          select: { fullName: true },
          take: 2,
        })
      : [];
    const ocrEnabled =
      this.config?.get("OCR_MODE") === "external" &&
      this.config.get("OCR_WORKER_ENABLED") !== "false";
    return {
      documentId,
      version,
      reviewGroup: row.document.reviewGroup,
      status: row.status,
      revision: row.revision,
      canRetryOcr: canRetryDocumentOcr(row, ocrEnabled),
      canStartOcr: canStartDocumentOcr(row, ocrEnabled),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy ?? null,
      reviewedByName: reviewers.length === 1 ? reviewers[0].fullName : null,
      ocrFields: (row.ocrFields ?? [])
        .filter((observation) =>
          row.fields.some(
            (field) =>
              field.required && field.name === observation.documentFieldName,
          ),
        )
        .map(
          ({
            name,
            documentFieldName,
            value,
            source,
            paddleText,
            paddleConfidence,
          }) => ({
            name,
            documentFieldName,
            value,
            source,
            paddleText,
            paddleConfidence,
          }),
        ),
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
      fields: row.fields.map((f) => {
        const rawOcrText = f.ocrText ?? f.originalValue;
        const isRussianSeries = isRussianPassport && f.name === "series";
        return {
          name: f.name,
          originalValue: f.required
            ? isRussianSeries
              ? normalizeRussianPassportSeries(f.originalValue)
              : f.originalValue
            : null,
          ocrText: f.required
            ? isRussianSeries
              ? normalizeRussianPassportSeries(rawOcrText)
              : rawOcrText
            : null,
          value: f.value,
          editedBy: f.editedBy,
          submittedValue: f.submittedValue,
          label: FIELD_LABELS[f.name] ?? f.name,
          kind: f.kind,
          required: f.required,
          mismatch:
            !!f.submittedValue?.trim() &&
            f.required &&
            !!rawOcrText?.trim() &&
            !ocrValuesMatch(f.submittedValue, rawOcrText, f, isRussianPassport),
          regions: (f.required ? f.regions : []).map((region) => ({
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
        };
      }),
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
      raw: null,
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
              httpStatus: a.httpStatus,
              responseBody: a.responseBody,
              responseTruncated: a.responseTruncated,
              responseReadError: a.responseReadError,
            })),
          }
        : null,
    };
  }

  async ocrDetails(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
  ): Promise<DocumentOcrDetailsDto> {
    if (!hasAccessRule(principal.accessRules, EdoAccessRule.OCR_DETAILS_VIEW))
      throw new ForbiddenException("Missing required EDO access rule");
    await this.access.document(documentId, principal);
    const row = await this.prisma.documentVersion.findUnique({
      where: { documentId_version: { documentId, version } },
      include: {
        ocrFields: {
          orderBy: { ordinal: "asc" },
          include: {
            regions: { include: { file: { select: { ordinal: true } } } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException("Document version not found");
    return {
      revision: row.revision,
      fields: row.ocrFields.map((field) => ({
        name: field.name,
        documentFieldName: field.documentFieldName,
        value: field.value,
        source: field.source,
        paddleText: field.paddleText,
        paddleConfidence: field.paddleConfidence,
        // A single source segment may feed both series and number.
        regions: Array.from(
          new Map(
            field.regions.map((region) => [
              JSON.stringify([
                region.fileId,
                region.pageNumber,
                region.x,
                region.y,
                region.width,
                region.height,
                region.text,
              ]),
              {
                id: region.id,
                fileId: region.fileId,
                fileOrdinal: region.file.ordinal,
                pageNumber: region.pageNumber,
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                text: region.text,
              },
            ]),
          ).values(),
        ),
      })),
      raw: row.ocrRaw,
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

  async types(catalogOnly = false) {
    return {
      items: await this.prisma.documentType.findMany({
        where: catalogOnly ? { catalogSyncedAt: { not: null } } : undefined,
        select: { code: true, title: true },
        orderBy: catalogOnly ? { title: "asc" } : { code: "asc" },
      }),
    };
  }

  /**
   * LK position directory for the review queue position filter. Reference
   * data: the location scope does not apply to positions, only REQUIRE ACCESS
   * on the controller guards this endpoint.
   */
  async positions(query: {
    q?: string;
    limit?: number;
  }): Promise<PositionListDto> {
    const { limit = 50 } = query;
    const needle = query.q?.trim();
    const rows = await this.prisma.lkPosition.findMany({
      where: {
        deleted: false,
        ...(needle ? { name: { contains: needle } } : {}),
      },
      select: { code1c: true, name: true },
      orderBy: { name: "asc" },
      take: limit,
    });
    return {
      items: rows.map((r) => ({ code: r.code1c, name: r.name })),
    };
  }

  /**
   * Distinct review-queue filter values, strictly inside the caller's access
   * scope: candidate ids are collected through access.documentWhere first, so
   * a 20007 principal can never see another location's managers/mentors.
   * Distinct over candidates (not documents), each group capped at 500.
   */
  async reviewDocumentFacets(
    principal: AuthPrincipal,
    reviewGroup: ReviewGroup = "RU",
  ): Promise<ReviewDocumentFacetsDto> {
    const ids = await this.reviewCandidateIds(principal, reviewGroup);
    if (ids.length === 0)
      return { managers: [], mentors: [], projects: [], citizenships: [] };
    const candidates = await this.prisma.candidate.findMany({
      where: { id: { in: ids } },
      select: {
        managerName: true,
        managerCode1c: true,
        mentorName: true,
        mentorCode1c: true,
        projectName: true,
        projectCode: true,
        citizenship: true,
      },
    });
    const byName = <T extends { name: string }>(rows: T[]): T[] =>
      rows.sort((a, b) => a.name.localeCompare(b.name, "ru")).slice(0, 500);
    const managers = new Map<string, { name: string; code1c: string | null }>();
    const mentors = new Map<string, { name: string; code1c: string | null }>();
    const projects = new Map<string, { name: string; code: string | null }>();
    const citizenships = new Set<string>();
    for (const c of candidates) {
      const manager = c.managerName?.trim();
      if (manager) {
        const key = c.managerCode1c
          ? `code:${c.managerCode1c}`
          : `name:${manager}`;
        if (!managers.has(key))
          managers.set(key, { name: manager, code1c: c.managerCode1c });
      }
      const mentor = c.mentorName?.trim();
      if (mentor) {
        const key = c.mentorCode1c
          ? `code:${c.mentorCode1c}`
          : `name:${mentor}`;
        if (!mentors.has(key))
          mentors.set(key, { name: mentor, code1c: c.mentorCode1c });
      }
      const project = c.projectName?.trim();
      if (project) {
        const key = c.projectCode ? `code:${c.projectCode}` : `name:${project}`;
        if (!projects.has(key))
          projects.set(key, { name: project, code: c.projectCode });
      }
      const citizenship = c.citizenship?.trim().toUpperCase();
      if (citizenship) citizenships.add(citizenship);
    }
    return {
      managers: byName([...managers.values()]),
      mentors: byName([...mentors.values()]),
      projects: byName([...projects.values()]),
      citizenships: [...citizenships].sort(),
    };
  }

  /**
   * Candidates that own at least one document inside the caller's access
   * scope — backing the review queue fullName selector.
   */
  async reviewCandidates(
    principal: AuthPrincipal,
    query: ReviewCandidatesQueryDto,
  ): Promise<ReviewCandidateListDto> {
    const { limit = 20 } = query;
    const ids = await this.reviewCandidateIds(
      principal,
      query.reviewGroup ?? "RU",
    );
    if (ids.length === 0) return { items: [] };
    const needle = query.q?.trim();
    const rows = await this.prisma.candidate.findMany({
      where: {
        id: { in: ids },
        ...(needle ? { fullName: { contains: needle } } : {}),
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
      take: limit,
    });
    return {
      items: rows.map((r) => ({ id: r.id, fullName: r.fullName })),
    };
  }

  /** Distinct candidate ids owning live (currentVersion > 0) scoped documents. */
  private async reviewCandidateIds(
    principal: AuthPrincipal,
    reviewGroup: ReviewGroup,
  ): Promise<string[]> {
    requireReviewGroup(principal, reviewGroup);
    const docs = await this.prisma.document.findMany({
      where: {
        ...this.access.documentWhere(principal),
        currentVersion: { gt: 0 },
        candidateId: { not: null },
        reviewGroup,
      },
      select: { candidateId: true },
      distinct: ["candidateId"],
    });
    return [
      ...new Set(
        docs
          .map((d) => d.candidateId)
          .filter((id): id is string => id !== null),
      ),
    ];
  }
  scopeWhere(scope: {
    candidateId?: string;
    chat_uuid?: string;
    code_1c?: string;
  }): Prisma.DocumentWhereInput {
    if (!scope.candidateId && !scope.chat_uuid && !scope.code_1c)
      throw new BadRequestException("Document owner is required");
    return {
      candidate: {
        ...(scope.candidateId
          ? { id: scope.candidateId }
          : scope.chat_uuid
            ? { chatUuid: scope.chat_uuid.toLowerCase() }
            : { code1c: scope.code_1c }),
      },
    };
  }
  async internalDocuments(scope: {
    candidateId?: string;
    chat_uuid?: string;
    code_1c?: string;
  }) {
    return this.documents({
      ...this.scopeWhere(scope),
      currentVersion: { gt: 0 },
    });
  }
  async internalDraft(
    scope: { candidateId?: string; chat_uuid?: string; code_1c?: string },
    documentUid: string,
  ): Promise<CandidateDocumentDraftDto> {
    const document = await this.prisma.document.findFirst({
      where: {
        ...this.scopeWhere(scope),
        documentType: { erpUid: documentUid },
        status: "RETURNED",
        currentVersion: { gt: 0 },
      },
      select: {
        currentVersion: true,
        versions: {
          where: { status: "RETURNED" },
          select: {
            version: true,
            fields: {
              select: { name: true, kind: true, submittedValue: true },
            },
          },
        },
      },
    });
    const version = document?.versions.find(
      (v) => v.version === document.currentVersion,
    );
    if (!version) throw new NotFoundException("Returned document not found");
    return {
      documentUid,
      version: version.version,
      fields: version.fields.map((field) => ({
        name: field.name,
        value:
          field.submittedValue === null
            ? null
            : field.kind === "boolean"
              ? field.submittedValue === "true"
              : field.submittedValue,
      })),
    };
  }
  async documentInfo(id: string, principal: AuthPrincipal) {
    await this.access.document(id, principal);
    return (await this.documents({ id })).items[0];
  }
  /** The same document predicate selects candidates and their nested documents. */
  private reviewDocumentWhere(
    principal: AuthPrincipal,
    query: {
      status?: string;
      documentTypeCode?: string;
      reviewGroup?: ReviewGroup;
    },
  ): Prisma.DocumentWhereInput {
    const { status, documentTypeCode, reviewGroup = "RU" } = query;
    requireReviewGroup(principal, reviewGroup);
    return {
      ...this.access.documentWhere(principal),
      reviewGroup,
      currentVersion: { gt: 0 },
      ...(documentTypeCode ? { documentType: { code: documentTypeCode } } : {}),
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
          : status === "RETURNED"
            ? { versions: { some: { status: "RETURNED" } } }
            : { status: "IN_REVIEW" }),
    };
  }

  async candidateReviewQueue(
    principal: AuthPrincipal,
    query: CandidateReviewQueueQueryDto = {},
  ): Promise<CandidateReviewQueueDto> {
    const {
      limit = 50,
      cursor,
      status,
      documentTypeCode,
      reviewGroup = "RU",
      ...profile
    } = query;
    const documentsWhere = this.reviewDocumentWhere(principal, {
      status,
      documentTypeCode,
      reviewGroup,
    });
    const rows = await this.prisma.candidate.findMany({
      where: {
        AND: [
          this.access.candidateWhere(principal),
          buildCandidateProfileWhere(profile) ?? {},
          ...(cursor ? [{ id: { gt: cursor } }] : []),
          { documents: { some: documentsWhere } },
        ],
      },
      include: {
        documents: {
          where: documentsWhere,
          include: documentSummaryInclude,
          orderBy: { id: "asc" },
        },
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const items = rows.slice(0, limit).map((row) => ({
      candidate: toCandidateProfile(row)!,
      documents: row.documents.map((d) => this.documentSummary(d)),
    }));
    await this.enrichReviewCandidates(
      principal,
      items.map((item) => item.candidate),
    );
    return {
      items,
      nextCursor:
        rows.length > limit ? items[items.length - 1].candidate.id : null,
    };
  }

  async reviewDocuments(
    principal: AuthPrincipal,
    query: ReviewDocumentsQueryDto = {},
  ) {
    const {
      limit = 50,
      cursor,
      status,
      documentTypeCode,
      reviewGroup = "RU",
      ...profile
    } = query;
    const candidate = buildCandidateProfileWhere(profile);
    const where: Prisma.DocumentWhereInput = {
      ...this.reviewDocumentWhere(principal, {
        status,
        documentTypeCode,
        reviewGroup,
      }),
      ...(cursor ? { id: { gt: cursor } } : {}),
      ...(candidate
        ? {
            candidate: {
              AND: [
                ...(Array.isArray(candidate.AND) ? candidate.AND : [candidate]),
              ],
            },
          }
        : {}),
    };
    const rows = await this.prisma.document.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: limit + 1,
    });
    const ids = rows.slice(0, limit).map((r) => r.id);
    const documents = await this.documents({ id: { in: ids } });
    const items = ids.map((id) => documents.items.find((d) => d.id === id)!);
    await this.enrichReviewCandidates(
      principal,
      items.flatMap((d) => (d.candidate ? [d.candidate] : [])),
    );
    return {
      items,
      nextCursor: rows.length > limit ? ids[ids.length - 1] : null,
    };
  }

  /**
   * Patches review-queue candidate profiles with the per-candidate document
   * progress. Counters are global per candidate and tab-independent: APPROVED
   * counts run over the same access scope as the queue (documentWhere)
   * without the status/tab filters, so "approved X of Y" stays stable across
   * tabs. Exactly 2 queries per page (scoped groupBy, catalog snapshot) —
   * never N+1 per document.
   */
  private async enrichReviewCandidates(
    principal: AuthPrincipal,
    profiles: CandidateProfileDto[],
  ): Promise<void> {
    const candidateIds = [...new Set(profiles.map((profile) => profile.id))];
    if (candidateIds.length === 0) return;
    const [grouped, catalog] = await Promise.all([
      this.prisma.document.groupBy({
        by: ["candidateId", "status"],
        where: {
          candidateId: { in: candidateIds },
          ...this.access.documentWhere(principal),
        },
        _count: { _all: true },
      }),
      // Catalog snapshot only: no ERP refresh inside the queue read path.
      this.prisma.documentType.findMany({
        where: { catalogSyncedAt: { not: null } },
        include: { positions: true },
      }),
    ]);
    const approved = new Map<string, number>();
    for (const row of grouped) {
      if (row.candidateId && row.status === "APPROVED")
        approved.set(
          row.candidateId,
          (approved.get(row.candidateId) ?? 0) + row._count._all,
        );
    }
    for (const profile of profiles) {
      const positionCode = profile.positionCode;
      const citizenship = (profile.citizenship ?? "ru").toLowerCase();
      profile.approvedDocuments = approved.get(profile.id) ?? 0;
      profile.requiredDocuments = positionCode
        ? catalog.filter((type) => applicable(type, positionCode, citizenship))
            .length
        : null;
    }
  }
}
