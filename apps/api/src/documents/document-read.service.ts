import { IgEnrichmentQueueService } from "./ig-enrichment-queue.service";
import type { Readable } from "node:stream";
import {
  candidateReviewGroup,
  IG_PASSPORT_LATIN_FIELDS,
  IG_PASSPORT_OCR_NAMES,
  isForeignPassport,
  requireReviewGroup,
  reviewGroupWhere,
  type ReviewGroup,
} from "./review-group";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { usablePreviousUids } from "./ig-completion";
import { previousDocumentAvailability } from "./previous-document-availability";
import { documentCheckEnabled } from "../ocr/document-check";
import { erpDeliveryReason } from "./erp-delivery-error";
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
import {
  classifyStageType,
  reviewStageProgress,
} from "./review-stage-progress";
import { DocumentCatalogService } from "./document-catalog.service";
import {
  requiredApplicable,
  excludedForSex,
  FIELD_LABELS,
  sexExceptionDocumentCodes,
} from "./document-contract";
import {
  normalizeRussianPassportSeries,
  resolveOcrProfile,
} from "../ocr/ocr-profile";
import {
  buildCandidateProfileWhere,
  parseBirthDateBound,
  toCandidateProfile,
} from "./candidate-profile";
import type {
  CandidateDocumentDraftDto,
  CandidateDetailsDto,
  CandidateStageItemDto,
  CandidateDocumentSummaryDto,
  CandidateProfileDto,
  CandidateReviewQueueDto,
  CandidateReviewQueueQueryDto,
  CandidateDto,
  CandidateListDto,
  DocumentDto,
  DocumentListDto,
  EmployeeDocumentListDto,
  MissingDocumentTypeDto,
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
      submission: { select: { origin: true } },
    },
  },
} satisfies Prisma.DocumentInclude;

const versionInclude = {
  document: { include: { documentType: true, candidate: true } },
  submission: { select: { id: true, status: true, origin: true } },
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
  ocrFields: {
    orderBy: { ordinal: "asc" as const },
    include: { regions: { include: { file: { select: { ordinal: true } } } } },
  },
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
    @Optional() private readonly catalog?: DocumentCatalogService,
    @Optional() private readonly enrichment?: IgEnrichmentQueueService,
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
          reviewGroup: d.candidate ? candidateReviewGroup(d.candidate) : "RU",
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
      uploadOrigin: current?.submission?.origin,
      documentTypeCode: d.documentType?.code ?? null,
      status: d.status,
      currentVersion: d.currentVersion,
      revision: current?.revision ?? 0,
      submittedAt: current?.submittedAt?.toISOString() ?? null,
      reviewedAt: current?.reviewedAt?.toISOString() ?? null,
      reviewedBy: current?.reviewedBy ?? null,
      ocrStatus: current?.job?.status ?? null,
      ocrErrorCode: null,
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
    stage?: string,
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
    const previous =
      owner.erpUid ||
      owner.code1c ||
      owner.personUid ||
      owner.isReemployment ||
      owner.previousDocumentsSyncedAt
        ? await this.prisma.candidatePreviousDocument.findMany({
            where: { candidateId: id },
          })
        : [];
    const isIg = candidateReviewGroup(owner) === "IG";
    const previousUids = new Set(
      usablePreviousUids(
        previous.filter(
          (doc) =>
            doc.status === "CONFIRMED" &&
            doc.originalAvailable &&
            (!isIg || doc.originalVerified),
        ),
        isIg,
      ),
    );
    const applicableTypes: Parameters<typeof previousDocumentAvailability>[0] =
      [];
    let stageDocuments: CandidateDetailsDto["stageDocuments"];
    if (stage !== undefined) {
      stageDocuments = null;
      if (candidate.citizenship) {
        const types = await this.prisma.documentType.findMany({
          where: { catalogSyncedAt: { not: null } },
          include: {
            positions: true,
            stageRules: {
              include: { positions: true, projects: true, countries: true },
            },
          },
          orderBy: { title: "asc" },
        });
        if (types.length) {
          const selectedStage = stage === "none" ? null : Number(stage);
          const profile = {
            positionCode: candidate.positionCode ?? "",
            projectCode: candidate.projectCode,
            citizenship: candidate.citizenship,
            sex: candidate.sexKnown ? candidate.sex : null,
          };
          stageDocuments = {
            required: { documents: [], missingDocuments: [] },
            additional: { documents: [], missingDocuments: [] },
          };
          for (const type of types) {
            const category = classifyStageType(type, selectedStage, profile);
            if (!category) continue;
            applicableTypes.push({ ...type, category });
            const doc = rows.find((row) => row.documentTypeId === type.id);
            if (doc)
              stageDocuments[category].documents.push(
                this.documentSummary(doc),
              );
            if (
              (!doc &&
                !(
                  type.erpUid && previousUids.has(type.erpUid.toLowerCase())
                )) ||
              (doc?.status === "DRAFT" &&
                !(type.erpUid && previousUids.has(type.erpUid.toLowerCase())))
            )
              stageDocuments[category].missingDocuments.push({
                code: type.code,
                title: type.title,
              });
          }
        }
      }
    }
    let documentGroups: CandidateDetailsDto["documentGroups"];
    if (stage === undefined) {
      documentGroups = null;
      if (candidate.citizenship) {
        const types = await this.prisma.documentType.findMany({
          where: { catalogSyncedAt: { not: null } },
          include: {
            positions: true,
            stageRules: {
              include: { positions: true, projects: true, countries: true },
            },
          },
          orderBy: { title: "asc" },
        });
        if (types.length) {
          const profile = {
            positionCode: candidate.positionCode ?? "",
            projectCode: candidate.projectCode,
            citizenship: candidate.citizenship,
            sex: candidate.sexKnown ? candidate.sex : null,
          };
          documentGroups = {
            required: { documents: [], missingDocuments: [] },
            additional: { documents: [], missingDocuments: [] },
          };
          const requiredIds = new Set(
            types
              .filter((type) =>
                (type.stageRules?.length ? type.stageRules : [type]).some(
                  (rule) =>
                    classifyStageType(type, rule.stage ?? null, profile) ===
                    "required",
                ),
              )
              .map((type) => type.id),
          );
          for (const row of rows) {
            const category =
              row.documentTypeId && requiredIds.has(row.documentTypeId)
                ? "required"
                : "additional";
            documentGroups[category].documents.push(this.documentSummary(row));
          }
          const uploaded = new Set(rows.map((row) => row.documentTypeId));
          for (const type of types) {
            const rules = type.stageRules?.length ? type.stageRules : [type];
            const category = requiredIds.has(type.id)
              ? "required"
              : rules.some(
                    (rule) =>
                      classifyStageType(type, rule.stage ?? null, profile) ===
                      "additional",
                  )
                ? "additional"
                : null;
            if (category) applicableTypes.push({ ...type, category });
            if (
              uploaded.has(type.id) ||
              (type.erpUid && previousUids.has(type.erpUid.toLowerCase()))
            )
              continue;
            if (category)
              documentGroups[category].missingDocuments.push({
                code: type.code,
                title: type.title,
              });
          }
        }
      }
    }
    let allStages: CandidateStageItemDto[] | undefined;
    if (candidate.citizenship) {
      const types = await this.prisma.documentType.findMany({
        where: { catalogSyncedAt: { not: null } },
        include: {
          positions: true,
          stageRules: {
            include: { positions: true, projects: true, countries: true },
          },
        },
        orderBy: { title: "asc" },
      });
      if (types.length) {
        const profile = {
          positionCode: candidate.positionCode ?? "",
          projectCode: candidate.projectCode,
          citizenship: candidate.citizenship,
          sex: candidate.sexKnown ? candidate.sex : null,
        };
        const stageNumbers = new Set<number | null>();
        for (const type of types) {
          const rules = type.stageRules?.length ? type.stageRules : [type];
          for (const rule of rules) {
            const cat = classifyStageType(type, rule.stage ?? null, profile);
            if (cat) stageNumbers.add(rule.stage ?? null);
          }
        }
        if (stageNumbers.size === 0) stageNumbers.add(1);
        const sortedStages = [...stageNumbers].sort((a, b) => {
          if (a === null) return 1;
          if (b === null) return -1;
          return a - b;
        });
        allStages = sortedStages.map((stg) => {
          const stageItem: CandidateStageItemDto = {
            stage: stg,
            title: stg === null ? "Без этапа" : `Этап ${stg}`,
            required: { documents: [], missingDocuments: [] },
            additional: { documents: [], missingDocuments: [] },
            previousDocuments: [],
          };
          const stageApplicableTypes: Parameters<
            typeof previousDocumentAvailability
          >[0] = [];
          for (const type of types) {
            const category = classifyStageType(type, stg, profile);
            if (!category) continue;
            stageApplicableTypes.push({ ...type, category });
            const doc = rows.find((row) => row.documentTypeId === type.id);
            if (doc)
              stageItem[category].documents.push(this.documentSummary(doc));
            if (
              (!doc &&
                !(
                  type.erpUid && previousUids.has(type.erpUid.toLowerCase())
                )) ||
              (doc?.status === "DRAFT" &&
                !(type.erpUid && previousUids.has(type.erpUid.toLowerCase())))
            ) {
              stageItem[category].missingDocuments.push({
                code: type.code,
                title: type.title,
              });
            }
          }
          stageItem.previousDocuments = previousDocumentAvailability(
            stageApplicableTypes,
            previous,
            rows,
            isIg,
          );
          return stageItem;
        });
      }
    }
    return {
      candidate,
      documents: rows.map((row) => this.documentSummary(row)),
      previousDocuments: previousDocumentAvailability(
        applicableTypes,
        previous,
        rows,
        isIg,
      ),
      missingDocuments: await this.missingDocumentTypes(
        owner,
        rows.map((row) => row.documentType?.code),
        previousUids,
      ),
      ...(stage !== undefined ? { stageDocuments } : { documentGroups }),
      stages: allStages,
      ...((isIg || owner.erpUid) && this.enrichment
        ? { enrichment: await this.enrichment.status(id) }
        : {}),
    };
  }

  private async missingDocumentTypes(
    profile: {
      positionCode: string | null;
      projectCode?: string | null;
      citizenship: string | null;
      sex?: string | null;
      sexKnown?: boolean;
    } | null,
    uploadedCodes: (string | null | undefined)[],
    previousUids: Set<string> = new Set(),
  ): Promise<MissingDocumentTypeDto[] | null> {
    if (!profile || !profile.citizenship) return null;
    const types = await this.prisma.documentType.findMany({
      where: { catalogSyncedAt: { not: null } },
      include: {
        positions: true,
        stageRules: {
          include: { positions: true, projects: true, countries: true },
        },
      },
    });
    const uploaded = new Set(uploadedCodes);
    return types
      .filter(
        (type) =>
          requiredApplicable(
            type,
            profile.positionCode ?? "",
            profile.citizenship ?? "",
            profile.sexKnown &&
              (profile.sex === "female" || profile.sex === "male")
              ? profile.sex
              : null,
            profile.projectCode,
          ) &&
          !uploaded.has(type.code) &&
          !(type.erpUid && previousUids.has(type.erpUid.toLowerCase())),
      )
      .map(({ code, title }) => ({ code, title }));
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
  ): Promise<EmployeeDocumentListDto> {
    const employee = await this.access.employee(id, principal);
    const documents = await this.documents({
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
    let profile = employee.lkEmployeeCode1c
      ? await this.prisma.candidate.findFirst({
          where: {
            AND: [
              { code1c: employee.lkEmployeeCode1c },
              this.access.candidateWhere(principal),
            ],
          },
          orderBy: { updatedAt: "desc" },
          select: {
            positionCode: true,
            projectCode: true,
            citizenship: true,
            sex: true,
            sexKnown: true,
          },
        })
      : null;
    if (!profile?.positionCode && employee.lkEmployeeCode1c) {
      const lk = await this.prisma.lkEmployee.findUnique({
        where: { code1c: employee.lkEmployeeCode1c },
        select: { positionCode1c: true, citizenship: true },
      });
      if (
        lk?.positionCode1c &&
        /^[a-z]{2}$/i.test(lk.citizenship?.trim() ?? "")
      ) {
        profile = {
          positionCode: lk.positionCode1c,
          projectCode: null,
          citizenship: lk.citizenship!.trim(),
          sex: null,
          sexKnown: false,
        };
      }
    }
    return {
      ...documents,
      missingDocuments: await this.missingDocumentTypes(
        profile,
        documents.items
          .filter((doc) => doc.currentVersion > 0)
          .map((doc) => doc.documentTypeCode),
      ),
    };
  }

  async version(
    documentId: string,
    version: number,
    principal?: AuthPrincipal,
  ): Promise<DocumentVersionDto> {
    const canDebug = hasAccessRule(
      principal?.accessRules,
      EdoAccessRule.FULL_ACCESS,
    );
    const row = await this.prisma.documentVersion.findUnique({
      where: { documentId_version: { documentId, version } },
      include: versionInclude,
    });
    if (!row) throw new NotFoundException("Document version not found");
    const foreignPassport = isForeignPassport(row.document);
    const canViewOcrDetails =
      !!principal &&
      hasAccessRule(principal.accessRules, EdoAccessRule.OCR_DETAILS_VIEW);
    const isRequired = (field: { name: string; required: boolean }) =>
      foreignPassport ? field.name === "number" : field.required;
    const isLatinName = (name: string) =>
      foreignPassport &&
      IG_PASSPORT_LATIN_FIELDS.some((field) => field === name);
    const observationFor = (name: string) =>
      canViewOcrDetails && isLatinName(name)
        ? row.ocrFields?.find(
            (field) =>
              !!field.value?.trim() &&
              (IG_PASSPORT_OCR_NAMES[field.name] ?? field.documentFieldName) ===
                name,
          )
        : undefined;
    const regionDto = (region: {
      id: string;
      fileId: string;
      file: { ordinal: number };
      pageNumber: number;
      x: number;
      y: number;
      width: number;
      height: number;
      text: string | null;
    }) => ({
      id: region.id,
      fileId: region.fileId,
      fileOrdinal: region.file.ordinal,
      pageNumber: region.pageNumber,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      text: region.text,
    });
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
      reviewGroup: row.document.candidate
        ? candidateReviewGroup(row.document.candidate)
        : "RU",
      status: row.status,
      revision: row.revision,
      canRetryOcr: canRetryDocumentOcr(
        row,
        ocrEnabled,
        documentCheckEnabled(this.config),
      ),
      canStartOcr: canStartDocumentOcr(
        row,
        ocrEnabled,
        documentCheckEnabled(this.config),
      ),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewedBy: row.reviewedBy ?? null,
      reviewedByName:
        row.reviewedBy === "ocr-document-check"
          ? "Автоматическая проверка"
          : reviewers.length === 1
            ? reviewers[0].fullName
            : null,
      ocrFields: (row.ocrFields ?? [])
        .filter(
          (observation) =>
            (canViewOcrDetails &&
              isLatinName(
                IG_PASSPORT_OCR_NAMES[observation.name] ??
                  observation.documentFieldName ??
                  "",
              )) ||
            row.fields.some(
              (field) =>
                (isRequired(field) || (foreignPassport && canViewOcrDetails)) &&
                field.name === observation.documentFieldName,
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
      uploadOrigin: row.submission?.origin,
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
      fields: [
        ...row.fields.map((f) => {
          const observation = observationFor(f.name);
          const rawOcrText =
            f.ocrText ?? f.originalValue ?? observation?.value ?? null;
          const isRussianSeries = isRussianPassport && f.name === "series";
          const required = isRequired(f);
          const showOcr = required || (foreignPassport && canViewOcrDetails);
          return {
            name: f.name,
            originalValue: showOcr
              ? isRussianSeries
                ? normalizeRussianPassportSeries(f.originalValue)
                : (f.originalValue ?? observation?.value ?? null)
              : null,
            ocrText: showOcr
              ? isRussianSeries
                ? normalizeRussianPassportSeries(rawOcrText)
                : rawOcrText
              : null,
            value: f.value,
            editedBy: f.editedBy,
            submittedValue: f.submittedValue,
            label: FIELD_LABELS[f.name] ?? f.name,
            kind: f.kind,
            required,
            ...(foreignPassport ? { reviewVisible: true } : {}),
            mismatch:
              !!f.submittedValue?.trim() &&
              showOcr &&
              !!rawOcrText?.trim() &&
              !ocrValuesMatch(
                f.submittedValue,
                rawOcrText,
                f,
                isRussianPassport,
              ),
            regions: (showOcr
              ? f.regions.length
                ? f.regions
                : (observation?.regions ?? [])
              : []
            ).map(regionDto),
          };
        }),
        ...(foreignPassport
          ? ["number", ...IG_PASSPORT_LATIN_FIELDS]
              .filter(
                (name) => !row.fields.some((field) => field.name === name),
              )
              .map((name) => {
                const observation = observationFor(name);
                return {
                  name,
                  originalValue: observation?.value ?? null,
                  ocrText: observation?.value ?? null,
                  value: null,
                  editedBy: null,
                  submittedValue: null,
                  label: FIELD_LABELS[name],
                  kind: "text",
                  required: name === "number",
                  reviewVisible: true,
                  mismatch: false,
                  regions: (observation?.regions ?? []).map(regionDto),
                };
              })
          : []),
      ],
      issues: row.issues.map((i) => ({
        code: i.code,
        message: i.message,
        fileOrdinal: i.fileOrdinal,
        pageNumber: i.pageNumber,
      })),
      job:
        canDebug && row.job
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
            // The technical code and the attempts stay a diagnostic (admins
            // only); every reviewer gets a plain explanation of the failure.
            errorCode: canDebug ? row.delivery.errorCode : null,
            errorReason: principal
              ? erpDeliveryReason(row.delivery.errorCode)
              : null,
            attempts: (canDebug ? row.delivery.attempts : []).map((a) => ({
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
      raw: hasAccessRule(principal.accessRules, EdoAccessRule.FULL_ACCESS)
        ? row.ocrRaw
        : null,
    };
  }

  async publicVersion(
    documentId: string,
    version: number,
    principal: AuthPrincipal,
  ): Promise<DocumentVersionDto> {
    await this.access.document(documentId, principal);
    return this.version(documentId, version, principal);
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
        // Returned/incomplete uploads are unavailable even while cleanup is pending.
        OR: [
          { version: { job: null } },
          {
            version: {
              job: { status: "REJECTED", cleanupPending: false },
            },
          },
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
    const [url, previewUrl] = await Promise.all([
      this.storage.downloadUrl(file.storageKey, file.filename),
      this.storage.previewUrl(file.storageKey, file.filename),
    ]);
    return {
      url,
      previewUrl,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }

  async fileStream(
    documentId: string,
    version: number,
    fileId: string,
    principal: AuthPrincipal,
  ): Promise<{
    stream: Readable;
    mimeType: string;
    filename: string;
    sizeBytes: number;
  }> {
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
        OR: [
          { version: { job: null } },
          {
            version: {
              job: { status: "REJECTED", cleanupPending: false },
            },
          },
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
    const stream = await this.storage.openRead(
      file.storageKey,
      AbortSignal.timeout(60_000),
    );
    return {
      stream,
      mimeType: file.mimeType,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
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
    includeAll = false,
  ): Promise<ReviewDocumentFacetsDto> {
    const ids =
      includeAll && reviewGroup === "RU"
        ? null
        : await this.reviewCandidateIds(principal, reviewGroup);
    if (ids?.length === 0)
      return { managers: [], mentors: [], projects: [], citizenships: [] };
    requireReviewGroup(principal, reviewGroup);
    const candidates = await this.prisma.candidate.findMany({
      where: ids
        ? { id: { in: ids } }
        : {
            AND: [
              this.access.candidateWhere(principal),
              reviewGroupWhere("RU"),
              { erpDeleted: false },
            ],
          },
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
    const group = query.reviewGroup ?? "RU";
    const ids =
      query.includeAll && group === "RU"
        ? null
        : await this.reviewCandidateIds(principal, group);
    if (ids?.length === 0 && group !== "IG") return { items: [] };
    requireReviewGroup(principal, group);
    const needle = query.q?.trim();
    const rows = await this.prisma.candidate.findMany({
      where: {
        ...(ids
          ? group === "IG"
            ? {
                AND: [
                  this.access.candidateWhere(principal),
                  reviewGroupWhere("IG"),
                  {
                    OR: [
                      { id: { in: ids } },
                      {
                        igEmploymentState: { isNot: null },
                        OR: [
                          { igCompletedAt: null },
                          { igCompletionVerified: false },
                        ],
                      },
                    ],
                  },
                ],
              }
            : { id: { in: ids } }
          : {
              AND: [
                this.access.candidateWhere(principal),
                reviewGroupWhere("RU"),
                { erpDeleted: false },
              ],
            }),
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
        candidate: reviewGroupWhere(reviewGroup),
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
  private async currentScopeWhere(scope: {
    candidateId?: string;
    chat_uuid?: string;
    code_1c?: string;
  }) {
    if (!scope.candidateId && !scope.chat_uuid && scope.code_1c) {
      const state = await this.prisma.igEmploymentState.findUnique({
        where: { code1c: scope.code_1c },
        select: { currentCandidateId: true },
      });
      if (state?.currentCandidateId)
        return this.scopeWhere({ candidateId: state.currentCandidateId });
    }
    return this.scopeWhere(scope);
  }
  async internalDocuments(scope: {
    candidateId?: string;
    chat_uuid?: string;
    code_1c?: string;
  }) {
    const state =
      !scope.candidateId && !scope.chat_uuid && scope.code_1c
        ? await this.prisma.igEmploymentState.findUnique({
            where: { code1c: scope.code_1c },
            select: { currentCandidateId: true },
          })
        : null;
    const result = await this.documents({
      ...this.scopeWhere(
        state?.currentCandidateId
          ? { candidateId: state.currentCandidateId }
          : scope,
      ),
      currentVersion: { gt: 0 },
    });
    const chatCandidate =
      !state?.currentCandidateId && scope.chat_uuid
        ? await this.prisma.candidate.findFirst({
            where: { chatUuid: scope.chat_uuid, erpDeleted: false },
            select: {
              id: true,
              reviewGroup: true,
              citizenship: true,
              chatUuid: true,
            },
          })
        : null;
    const previousCandidateId = state?.currentCandidateId ?? chatCandidate?.id;
    if (!previousCandidateId) return { ...result, reusedDocumentUids: [] };
    const isIg = state?.currentCandidateId
      ? true
      : candidateReviewGroup(chatCandidate!) === "IG";
    const previous = await this.prisma.candidatePreviousDocument.findMany({
      where: {
        candidateId: previousCandidateId,
        status: "CONFIRMED",
        originalAvailable: true,
        ...(isIg ? { originalVerified: true } : {}),
      },
    });
    const current = new Set(
      result.items.map((doc) => doc.documentUid?.toLowerCase()),
    );
    return {
      ...result,
      reusedDocumentUids: usablePreviousUids(previous, isIg).filter(
        (uid) => !current.has(uid),
      ),
    };
  }
  async internalDraft(
    scope: { candidateId?: string; chat_uuid?: string; code_1c?: string },
    documentUid: string,
  ): Promise<CandidateDocumentDraftDto> {
    const document = await this.prisma.document.findFirst({
      where: {
        ...(await this.currentScopeWhere(scope)),
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
      currentStatus?: ReviewDocumentsQueryDto["currentStatus"];
      documentTypeCode?: string;
      reviewGroup?: ReviewGroup;
    },
  ): Prisma.DocumentWhereInput {
    const {
      status,
      currentStatus,
      documentTypeCode,
      reviewGroup = "RU",
    } = query;
    requireReviewGroup(principal, reviewGroup);
    return {
      ...this.access.documentWhere(principal),
      candidate: reviewGroupWhere(reviewGroup),
      currentVersion: { gt: 0 },
      ...(documentTypeCode ? { documentType: { code: documentTypeCode } } : {}),
      ...(currentStatus
        ? { status: currentStatus }
        : status === "ALL"
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
      currentStatus,
      documentTypeCode,
      reviewGroup = "RU",
      createdFrom,
      createdTo,
      ...profile
    } = query;
    const from = createdFrom
      ? parseBirthDateBound(createdFrom, "createdFrom")
      : undefined;
    const to = createdTo
      ? parseBirthDateBound(createdTo, "createdTo")
      : undefined;
    if (from && to && from > to)
      throw new BadRequestException("createdFrom must not be after createdTo");
    const createdAt =
      from || to
        ? {
            ...(from
              ? { gte: new Date(from.getTime() - 8 * 60 * 60 * 1000) }
              : {}),
            ...(to ? { lt: new Date(to.getTime() + 16 * 60 * 60 * 1000) } : {}),
          }
        : undefined;
    const documentsWhere = this.reviewDocumentWhere(principal, {
      status,
      currentStatus,
      documentTypeCode,
      reviewGroup,
    });
    if (reviewGroup === "RU" && status === "ALL") {
      let after: { group: number; id: string; name: string | null } | undefined;
      if (cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
          );
          if (
            ![0, 1].includes(decoded.group) ||
            typeof decoded.id !== "string" ||
            (decoded.name !== null && typeof decoded.name !== "string")
          )
            throw new Error();
          after = decoded;
        } catch {
          throw new BadRequestException("Invalid candidate cursor");
        }
      }
      const uploadedWhere = {
        ...this.access.documentWhere(principal),
        currentVersion: { gt: 0 },
      };
      const common = [
        this.access.candidateWhere(principal),
        reviewGroupWhere("RU"),
        { erpDeleted: false },
        buildCandidateProfileWhere({ ...profile, reviewGroup }) ?? {},
        ...(createdAt ? [{ createdAt }] : []),
      ];
      const rows: {
        row: Prisma.CandidateGetPayload<{
          include: { documents: { include: typeof documentSummaryInclude } };
        }>;
        group: number;
      }[] = [];
      for (const group of [0, 1]) {
        if (after && group < after.group) continue;
        if (group === 1 && (currentStatus || documentTypeCode)) continue;
        const boundary =
          after && after.group === group
            ? after.name === null
              ? {
                  OR: [
                    { fullName: null, id: { gt: after.id } },
                    { fullName: { not: null } },
                  ],
                }
              : {
                  OR: [
                    { fullName: { gt: after.name } },
                    { fullName: after.name, id: { gt: after.id } },
                  ],
                }
            : undefined;
        const page = await this.prisma.candidate.findMany({
          where: {
            AND: [
              ...common,
              group === 0
                ? { documents: { some: uploadedWhere } }
                : { documents: { none: uploadedWhere } },
              ...(group === 0 && (currentStatus || documentTypeCode)
                ? [{ documents: { some: documentsWhere } }]
                : []),
              ...(boundary ? [boundary] : []),
            ],
          },
          include: {
            documents: {
              where: documentsWhere,
              include: documentSummaryInclude,
              orderBy: { id: "asc" },
            },
          },
          orderBy: [{ fullName: "asc" }, { id: "asc" }],
          take: limit + 1 - rows.length,
        });
        rows.push(...page.map((row) => ({ row, group })));
        if (rows.length > limit) break;
      }
      const page = rows.slice(0, limit);
      const items = page.map(({ row }) => ({
        candidate: toCandidateProfile(row)!,
        documents: row.documents.map((d) => this.documentSummary(d)),
      }));
      await this.enrichReviewCandidates(
        principal,
        items.map((item) => item.candidate),
      );
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  group: last.group,
                  id: last.row.id,
                  name: last.row.fullName,
                }),
              ).toString("base64url")
            : null,
      };
    }
    const rows = await this.prisma.candidate.findMany({
      where: {
        AND: [
          this.access.candidateWhere(principal),
          buildCandidateProfileWhere({ ...profile, reviewGroup }) ?? {},
          ...(createdAt ? [{ createdAt }] : []),
          ...(cursor ? [{ id: { gt: cursor } }] : []),
          ...(reviewGroup === "IG" &&
          (!status || status === "IN_REVIEW" || status === "ALL") &&
          !currentStatus &&
          !documentTypeCode
            ? [
                {
                  OR: [
                    { documents: { some: documentsWhere } },
                    {
                      ...reviewGroupWhere("IG"),
                      igEmploymentState: { isNot: null },
                      OR: [
                        { igCompletedAt: null },
                        { igCompletionVerified: false },
                      ],
                    },
                  ],
                },
              ]
            : [{ documents: { some: documentsWhere } }]),
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
      currentStatus,
      documentTypeCode,
      reviewGroup = "RU",
      ...profile
    } = query;
    const candidate = buildCandidateProfileWhere({ ...profile, reviewGroup });
    const where: Prisma.DocumentWhereInput = {
      ...this.reviewDocumentWhere(principal, {
        status,
        currentStatus,
        documentTypeCode,
        reviewGroup,
      }),
      ...(cursor ? { id: { gt: cursor } } : {}),
      ...(candidate
        ? {
            candidate: {
              AND: [
                reviewGroupWhere(reviewGroup),
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
  async enrichReviewCandidates(
    principal: AuthPrincipal,
    profiles: CandidateProfileDto[],
  ): Promise<void> {
    const candidateIds = [...new Set(profiles.map((profile) => profile.id))];
    if (candidateIds.length === 0) return;
    // A stale snapshot stays available while the catalog service refreshes it.
    // A catalog outage must not block the review queue.
    void this.catalog?.ensure().catch(() => undefined);
    const [grouped, catalog] = await Promise.all([
      this.prisma.document.groupBy({
        by: ["candidateId", "status", "documentTypeId"],
        where: {
          candidateId: { in: candidateIds },
          ...this.access.documentWhere(principal),
        },
        _count: { _all: true },
      }),
      // Catalog snapshot only: no ERP refresh inside the queue read path.
      this.prisma.documentType.findMany({
        where: {
          OR: [
            { catalogSyncedAt: { not: null } },
            { code: { in: sexExceptionDocumentCodes } },
          ],
        },
        include: {
          positions: true,
          stageRules: {
            include: { positions: true, projects: true, countries: true },
          },
        },
      }),
    ]);
    const igIds = profiles
      .filter(
        (profile) =>
          profile.reviewGroup === "RU" ||
          profile.code1c ||
          profile.isReemployment,
      )
      .map((profile) => profile.id);
    const historical = igIds.length
      ? await this.prisma.candidatePreviousDocument.findMany({
          where: {
            candidateId: { in: igIds },
            status: "CONFIRMED",
            originalAvailable: true,
            OR: [
              { originalVerified: true },
              { candidate: reviewGroupWhere("RU") },
            ],
          },
        })
      : [];
    const authoritativeErpTypes = new Map<string, Set<string>>();
    for (const profile of profiles.filter((p) => p.reviewGroup === "RU")) {
      const uids = usablePreviousUids(
        historical.filter(
          (doc) =>
            doc.candidateId === profile.id && !doc.sourceId?.startsWith("edo:"),
        ),
        false,
      );
      authoritativeErpTypes.set(
        profile.id,
        new Set(
          catalog
            .filter(
              (type) => type.erpUid && uids.includes(type.erpUid.toLowerCase()),
            )
            .map((type) => type.id),
        ),
      );
    }
    const effectiveGrouped = grouped.filter(
      (row) =>
        !authoritativeErpTypes.get(row.candidateId!)?.has(row.documentTypeId!),
    );
    const approved = new Map<string, number>();
    const profileById = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    const typeById = new Map(catalog.map((type) => [type.id, type]));
    for (const row of effectiveGrouped) {
      const profile = row.candidateId
        ? profileById.get(row.candidateId)
        : undefined;
      const type = row.documentTypeId
        ? typeById.get(row.documentTypeId)
        : undefined;
      const excluded =
        profile?.sexKnown && excludedForSex(type?.code, profile.sex);
      const required =
        !profile?.positionCode ||
        !profile?.citizenship ||
        (!!type &&
          type.catalogSyncedAt !== null &&
          requiredApplicable(
            type,
            profile.positionCode ?? "",
            profile.citizenship ?? "",
            profile.sexKnown &&
              (profile.sex === "female" || profile.sex === "male")
              ? profile.sex
              : null,
            profile.projectCode,
          ));
      if (row.candidateId && row.status === "APPROVED" && !excluded && required)
        approved.set(
          row.candidateId,
          (approved.get(row.candidateId) ?? 0) + row._count._all,
        );
    }
    for (const profile of profiles) {
      const previousUids = usablePreviousUids(
        historical.filter((doc) => doc.candidateId === profile.id),
        profile.reviewGroup === "IG",
      );
      const reusedTypes = catalog.filter(
        (type) =>
          type.erpUid &&
          previousUids.includes(type.erpUid.toLowerCase()) &&
          !effectiveGrouped.some(
            (row) =>
              row.candidateId === profile.id &&
              row.documentTypeId === type.id &&
              row.status !== "DRAFT",
          ),
      );
      const hasProfile = !!profile.citizenship;
      const positionCode = profile.positionCode ?? "";
      const citizenship = (profile.citizenship ?? "").toLowerCase();
      profile.stageProgress =
        hasProfile && catalog.some((type) => type.catalogSyncedAt !== null)
          ? reviewStageProgress(
              catalog.filter((type) => type.catalogSyncedAt !== null),
              effectiveGrouped.filter((row) => row.candidateId === profile.id),
              {
                positionCode,
                projectCode: profile.projectCode,
                citizenship,
                sex: profile.sexKnown ? profile.sex : null,
              },
              previousUids,
              profile.reviewGroup === "IG",
            )
          : null;
      profile.approvedDocuments =
        (approved.get(profile.id) ?? 0) +
        reusedTypes.filter(
          (type) =>
            !profile.citizenship ||
            requiredApplicable(
              type,
              profile.positionCode ?? "",
              profile.citizenship ?? "",
              profile.sexKnown &&
                (profile.sex === "female" || profile.sex === "male")
                ? profile.sex
                : null,
              profile.projectCode,
            ),
        ).length;
      profile.requiredDocuments =
        profile.positionCode && profile.citizenship
          ? catalog.filter(
              (type) =>
                type.catalogSyncedAt !== null &&
                requiredApplicable(
                  type,
                  positionCode,
                  citizenship,
                  profile.sexKnown &&
                    (profile.sex === "female" || profile.sex === "male")
                    ? profile.sex
                    : null,
                  profile.projectCode,
                ),
            ).length
          : null;
    }
  }
}
