import { DocumentCatalogService } from "../documents/document-catalog.service";
import { tryCompleteIgEmployment } from "../documents/ig-completion";
import {
  isPreviousDocumentExpired,
  needsNewIgDocument,
} from "../documents/reemployment-document-policy";
import { CandidateDocumentError } from "../documents/candidate-document.error";
import {
  CandidateDocumentErrorCode,
  CandidateProfileField,
} from "../documents/dto/candidate-error.dto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { OwnDocumentHistoryService } from "../documents/own-document-history.service";
import { DocumentAccessService } from "../documents/document-access.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../documents/candidate-identity";
import {
  canReviewGroup,
  candidateReviewGroup,
  requireReviewGroup,
} from "../documents/review-group";
import {
  ErpWorkspaceClient,
  erpCardSchema,
  previousDocumentsSchema,
  referencesSchema,
  personMatchesSchema,
  type ErpCard,
} from "../documents/erp-workspace.client";
import {
  CandidatePersonLinkDto,
  CandidatePersonMatchQueryDto,
  CandidateRecheckRequestDto,
  CandidateStatusRequestDto,
  CreateCandidateDto,
  UpdateCandidateDto,
} from "./candidate-workspace.dto";

@Injectable()
export class CandidateWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly catalog: DocumentCatalogService,
    @Optional() private readonly ownHistory?: OwnDocumentHistoryService,
  ) {}
  private actor(p: AuthPrincipal) {
    requireReviewGroup(p, "RU");
    if (!p.code1c) throw new ForbiddenException("ERP_ACTOR_IDENTITY_REQUIRED");
    return p.code1c;
  }
  private async owner(id: string, p: AuthPrincipal) {
    requireReviewGroup(p, "RU");
    const row = await this.access.candidate(id, p);
    if (row.reviewGroup !== "RU" || !row.erpUid)
      throw new ConflictException("ERP_CANDIDATE_CONFIRMATION_REQUIRED");
    return row;
  }
  private async previousOwner(id: string, p: AuthPrincipal) {
    const row = await this.access.candidate(id, p);
    const group = candidateReviewGroup(row);
    requireReviewGroup(p, group);
    if (group === "RU") return this.owner(id, p);
    if (!row.code1c)
      throw new ConflictException("ERP_PERSON_IDENTITY_REQUIRED");
    const identity = await this.erp.identity(row.code1c);
    if (
      identity.reviewGroup !== "IG" ||
      identity.recipientType !== "person" ||
      !identity.personUid ||
      (row.personUid && row.personUid !== identity.personUid)
    )
      throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
    const personUid = identity.personUid;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findFirst({
        where: { id, ...this.access.candidateWhere(p) },
      });
      if (
        !current ||
        candidateReviewGroup(current) !== "IG" ||
        current.code1c !== row.code1c ||
        (current.personUid && current.personUid !== personUid)
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      requireReviewGroup(p, "IG");
      if (current.personUid) return current;
      const updated = await tx.candidate.update({
        where: { id },
        data: { personUid },
      });
      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "CANDIDATE_LINKED",
        entityType: "Candidate",
        entityId: id,
        correlationId: "",
        before: { personUid: null },
        after: { personUid },
      });
      return updated;
    });
  }
  private signature(value: string) {
    const secret = this.config.get<string>("JWT_SECRET");
    if (!secret)
      throw new ServiceUnavailableException("PERSON_SELECTION_NOT_CONFIGURED");
    return createHmac("sha256", secret)
      .update(`edo-person-selection:v1:${value}`)
      .digest("hex");
  }
  private selection(personUid: string, p: AuthPrincipal) {
    const value = Buffer.from(
      JSON.stringify({
        personUid,
        actor: p.uuid,
        exp: Date.now() + 15 * 60_000,
      }),
    ).toString("base64url");
    return `${value}.${this.signature(value)}`;
  }
  private person(selection: string, p: AuthPrincipal) {
    try {
      const [value, signature] = selection.split(".");
      const expected = Buffer.from(this.signature(value));
      if (
        !signature ||
        expected.length !== signature.length ||
        !timingSafeEqual(expected, Buffer.from(signature))
      )
        throw new Error();
      const data = JSON.parse(Buffer.from(value, "base64url").toString()) as {
        personUid: string;
        actor: string;
        exp: number;
      };
      if (
        data.actor !== p.uuid ||
        data.exp < Date.now() ||
        !/^[-a-f0-9]{36}$/i.test(data.personUid)
      )
        throw new Error();
      return data.personUid;
    } catch {
      throw new BadRequestException(
        "Выбор физлица устарел. Повторите поиск и подтвердите выбор.",
      );
    }
  }
  async references(
    kind: "managers" | "positions" | "projects" | "statuses" | "persons",
    p: AuthPrincipal,
    q?: string,
  ) {
    requireReviewGroup(p, "RU");
    if (kind === "persons" && (q?.trim().length ?? 0) < 3) return { items: [] };
    const result = await this.erp.request(
      kind,
      referencesSchema,
      q?.trim() ? { q: q.trim() } : {},
    );
    return kind === "persons"
      ? {
          items: result.items.map((row) => ({
            name: row.name,
            birthDate: row.birthDate ?? null,
            id: this.selection(row.id, p),
          })),
        }
      : result;
  }
  async personMatches(p: AuthPrincipal, query: CandidatePersonMatchQueryDto) {
    if (!canReviewGroup(p, "RU") && !canReviewGroup(p, "IG"))
      throw new ForbiddenException(
        "Missing required EDO review group access rule",
      );
    const result = await this.erp.request(
      "person-matches",
      personMatchesSchema,
      {
        lastName: query.lastName.trim(),
        firstName: query.firstName.trim(),
        birthDate: query.birthDate,
        ...(query.middleName?.trim()
          ? { middleName: query.middleName.trim() }
          : {}),
        ...(query.latinName?.trim()
          ? { latinName: query.latinName.trim() }
          : {}),
      },
    );
    return {
      items: result.items.map((row) => ({
        ...row,
        id: this.selection(row.id, p),
      })),
    };
  }
  private async project(card: ErpCard, p: AuthPrincipal, expectedId?: string) {
    return candidateIdentityTransaction(this.prisma, async (tx) => {
      const owner = await resolveCandidateIdentity(tx, {
        identityKey: `erp:${card.erpUid}`,
        erpUid: card.erpUid,
        chatUuid: card.chatUuid,
        personUid: card.personUid,
        reviewGroup: "RU",
        expectedId,
      });
      const data = {
        reviewGroup: "RU" as const,
        code1c: card.code1C,
        personUid: card.personUid,
        fullName: card.fullName,
        phone: card.phone,
        birthDate: new Date(`${card.birthDate.slice(0, 10)}T00:00:00Z`),
        citizenship: card.citizenship.toLowerCase(),
        positionCode: card.position?.code ?? null,
        positionName: card.position?.name ?? null,
        projectCode: card.project?.code ?? null,
        projectName: card.project?.name ?? null,
        managerName: card.manager?.name ?? null,
        managerId: card.manager?.id ?? null,
        mentorName: card.mentor?.name ?? null,
        mentorPosition: card.mentor?.position ?? null,
        statusId: card.status?.id ?? null,
        statusName: card.status?.name ?? null,
        profileSyncedAt: new Date(),
      };
      await tx.candidate.update({ where: { id: owner.id }, data });
      // Exact ERP candidate ownership proves RU; unlinked employee-only history
      // stays nullable for point reconciliation. Already classified rows never move.
      const classified = await tx.document.updateMany({
        where: { candidateId: owner.id, reviewGroup: null },
        data: { reviewGroup: "RU" },
      });
      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "DATA_IMPORTED",
        entityType: "CandidateWorkspace",
        entityId: owner.id,
        correlationId: "",
        after: {
          statusId: card.status?.id ?? null,
          source: "ERP",
          classifiedDocuments: classified.count,
        },
      });
      return {
        id: owner.id,
        reviewGroup: card.reviewGroup,
        fullName: card.fullName,
        phone: card.phone,
        birthDate: card.birthDate,
        citizenship: card.citizenship,
        position: card.position,
        project: card.project,
        manager: card.manager,
        mentor: card.mentor
          ? { name: card.mentor.name, position: card.mentor.position }
          : null,
        status: card.status,
        history: card.history,
        linkedPerson: !!card.personUid,
        hasChat: !!(card.chatUuid || owner.chatUuid),
      };
    });
  }
  async card(id: string, p: AuthPrincipal) {
    const row = await this.owner(id, p);
    const card = await this.erp.card(row.erpUid!);
    if (card.erpUid !== row.erpUid)
      throw new ConflictException("ERP_CANDIDATE_IDENTITY_CHANGED");
    return this.project(card, p, id);
  }
  async requirements(id: string, p: AuthPrincipal) {
    const owner = await this.owner(id, p);
    const card = await this.erp.card(owner.erpUid!);
    if (card.erpUid !== owner.erpUid)
      throw new ConflictException("ERP_CANDIDATE_IDENTITY_CHANGED");
    if (!card.position?.code)
      throw new CandidateDocumentError(
        CandidateDocumentErrorCode.CANDIDATE_PROFILE_INCOMPLETE,
        [CandidateProfileField.POSITION_CODE],
      );
    return this.catalog.list(card.position.code, card.citizenship);
  }
  async create(p: AuthPrincipal, body: CreateCandidateDto) {
    const actor = this.actor(p);
    const card = await this.erp.request(
      "create",
      erpCardSchema,
      {},
      {
        actor,
        requestId: body.requestId,
        fields: body.fields,
        ...(body.personSelection
          ? { personUid: this.person(body.personSelection, p) }
          : {}),
      },
    );
    return this.project(card, p);
  }
  async update(id: string, p: AuthPrincipal, body: UpdateCandidateDto) {
    const actor = this.actor(p),
      row = await this.owner(id, p);
    if (!Object.keys(body.fields).length)
      throw new BadRequestException("Нет изменений");
    const card = await this.erp.request(
      "update",
      erpCardSchema,
      {},
      { actor, candidate: row.erpUid, ...body },
    );
    return this.project(card, p, id);
  }
  async status(id: string, p: AuthPrincipal, body: CandidateStatusRequestDto) {
    const actor = this.actor(p),
      row = await this.owner(id, p);
    const statuses = await this.erp.request("statuses", referencesSchema);
    const status = statuses.items.find((s) => s.id === body.statusId);
    if (!status?.editable)
      throw new BadRequestException(
        "Этот статус меняется диспетчером или отделом кадров в ERP",
      );
    if (status.requiresProject && !body.projectCode)
      throw new BadRequestException("Для статуса требуется объект");
    if (status.requiresPlannedArrivalDate && !body.plannedArrivalDate)
      throw new BadRequestException("Для статуса требуется дата заезда");
    const card = await this.erp.request(
      "status",
      erpCardSchema,
      {},
      { actor, candidate: row.erpUid, ...body },
    );
    return this.project(card, p, id);
  }
  async link(id: string, p: AuthPrincipal, body: CandidatePersonLinkDto) {
    const actor = this.actor(p),
      row = await this.owner(id, p);
    const card = await this.erp.request(
      "link-person",
      erpCardSchema,
      {},
      {
        actor,
        candidate: row.erpUid,
        requestId: body.requestId,
        personUid: this.person(body.personSelection, p),
      },
    );
    return this.project(card, p, id);
  }
  async previous(id: string, p: AuthPrincipal) {
    const row = await this.previousOwner(id, p);
    const isIg = candidateReviewGroup(row) === "IG";
    const historyPromise = isIg
      ? this.erp
          .employmentHistory(row.code1c!, row.personUid!)
          .then((history) => ({ available: true, items: history.items }))
          .catch(() => ({ available: false, items: [] }))
      : undefined;
    const result = await this.erp.request(
      isIg ? "person-documents-by-code" : "person-documents",
      previousDocumentsSchema,
      isIg
        ? { code1c: row.code1c!, personUid: row.personUid! }
        : { candidate: row.erpUid! },
    );
    const edoDocuments = isIg
      ? await this.prisma.document.findMany({
          where: {
            currentVersion: { gt: 0 },
            candidate: {
              id: { not: id },
              code1c: row.code1c,
              chatUuid: null,
              AND: [
                { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
                { OR: [{ personUid: null }, { personUid: row.personUid }] },
              ],
            },
          },
          include: {
            documentType: true,
            versions: { include: { fields: true, files: true } },
          },
          orderBy: { createdAt: "desc" },
        })
      : [];
    const edoHistory = edoDocuments.flatMap((document) => {
      const version = document.versions.find(
        (v) => v.version === document.currentVersion,
      );
      if (!version) return [];
      const fields = Object.fromEntries(
        version.fields.map((field) => [
          field.name,
          field.kind === "boolean" && field.value !== null
            ? field.value === "true"
            : field.value,
        ]),
      );
      const expiry = fields.expiryDate;
      const parsedExpiry =
        typeof expiry === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(expiry) &&
        Number.isFinite(Date.parse(`${expiry}T00:00:00Z`)) &&
        new Date(`${expiry}T00:00:00Z`).toISOString().slice(0, 10) === expiry
          ? expiry
          : null;
      const originalAvailable = version.files.length
        ? version.files.some((file) => !file.deletedAt)
        : !!version.storageKey;
      return [
        {
          id: `edo:${document.id}:${version.id}`,
          documentUid: document.documentType?.erpUid ?? null,
          title: document.documentType?.title ?? "Документ",
          fields,
          expiresAt: parsedExpiry,
          originalAvailable,
          isInvalid:
            typeof fields.isInvalid === "boolean"
              ? fields.isInvalid
              : undefined,
          recordDate: undefined,
          recheckStatus: originalAvailable
            ? ("REQUIRES_REVIEW" as const)
            : ("ORIGINAL_UNAVAILABLE" as const),
        },
      ];
    });
    const allDocuments = [...result.items, ...edoHistory];
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findFirst({
        where: { id, ...this.access.candidateWhere(p) },
      });
      if (
        !current ||
        candidateReviewGroup(current) !== candidateReviewGroup(row) ||
        current.personUid !== row.personUid ||
        current.code1c !== row.code1c ||
        current.erpUid !== row.erpUid
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      requireReviewGroup(p, candidateReviewGroup(current));
      const oldDocuments = await tx.candidatePreviousDocument.findMany({
        where: { candidateId: id },
      });
      const oldBySource = new Map(
        oldDocuments.map((doc) => [doc.sourceId, doc]),
      );
      const seen = new Set<string>();
      for (const doc of allDocuments) {
        if (seen.has(doc.id))
          throw new ConflictException("ERP_DOCUMENT_DUPLICATE_SOURCE");
        seen.add(doc.id);
        const old = oldBySource.get(doc.id);
        if (
          old?.documentUid &&
          doc.documentUid &&
          old.documentUid !== doc.documentUid
        )
          throw new ConflictException("ERP_DOCUMENT_IDENTITY_MISMATCH");
        const oldFields =
          old?.fields &&
          typeof old.fields === "object" &&
          !Array.isArray(old.fields)
            ? old.fields
            : {};
        const isInvalid =
          doc.isInvalid !== undefined ? doc.isInvalid : oldFields.isInvalid;
        const recordDate =
          doc.recordDate !== undefined ? doc.recordDate : oldFields.recordDate;
        const fields = {
          ...doc.fields,
          ...(recordDate !== undefined ? { recordDate } : {}),
          ...(isInvalid !== undefined ? { isInvalid } : {}),
        } as Prisma.InputJsonObject;
        const expiresAt = doc.expiresAt
          ? new Date(`${doc.expiresAt}T00:00:00Z`)
          : null;
        const confirmedInvalid =
          old?.status === "CONFIRMED" &&
          (!doc.originalAvailable ||
            isInvalid === true ||
            (expiresAt !== null && isPreviousDocumentExpired(expiresAt)) ||
            (isIg &&
              (!doc.documentUid || needsNewIgDocument(doc.documentUid))));
        const nextStatus = confirmedInvalid
          ? !doc.originalAvailable
            ? "ORIGINAL_UNAVAILABLE"
            : "REPLACE"
          : old?.status === "CONFIRMED" &&
              (!isDeepStrictEqual(oldFields, fields) ||
                (old.expiresAt?.getTime() ?? null) !==
                  (expiresAt?.getTime() ?? null))
            ? "REQUIRES_REVIEW"
            : undefined;
        await tx.candidatePreviousDocument.upsert({
          where: {
            candidateId_sourceId: { candidateId: id, sourceId: doc.id },
          },
          create: {
            candidateId: id,
            sourceId: doc.id,
            documentUid: doc.documentUid,
            title: doc.title,
            fields,
            expiresAt,
            originalAvailable: doc.originalAvailable,
            status: doc.recheckStatus,
          },
          update: {
            title: doc.title,
            documentUid: doc.documentUid ?? old?.documentUid ?? null,
            fields,
            expiresAt,
            originalAvailable: doc.originalAvailable,
            ...(nextStatus
              ? { status: nextStatus, reviewedBy: null, reviewedAt: null }
              : {}),
          },
        });
        if (nextStatus && old)
          await this.audit.logInTransaction(tx, {
            actorId: p.uuid,
            action: "DOCUMENT_FIELDS_UPDATED",
            entityType: "CandidatePreviousDocument",
            entityId: old.id,
            correlationId: "",
            before: { status: old.status },
            after: { status: nextStatus, source: "ERP_REVALIDATION" },
          });
      }
      for (const old of oldDocuments) {
        if (
          seen.has(old.sourceId) ||
          (!old.originalAvailable && old.status !== "CONFIRMED")
        )
          continue;
        const nextStatus =
          old.status === "CONFIRMED" ? "ORIGINAL_UNAVAILABLE" : old.status;
        await tx.candidatePreviousDocument.update({
          where: { id: old.id },
          data: {
            originalAvailable: false,
            status: nextStatus,
            ...(old.status === "CONFIRMED"
              ? { reviewedBy: null, reviewedAt: null }
              : {}),
          },
        });
        await this.audit.logInTransaction(tx, {
          actorId: p.uuid,
          action: "DOCUMENT_FIELDS_UPDATED",
          entityType: "CandidatePreviousDocument",
          entityId: old.id,
          correlationId: "",
          before: {
            status: old.status,
            originalAvailable: old.originalAvailable,
          },
          after: {
            status: nextStatus,
            originalAvailable: false,
            source: "ERP_REVALIDATION",
          },
        });
      }
      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "DATA_IMPORTED",
        entityType: "CandidatePreviousDocuments",
        entityId: id,
        correlationId: "",
        after: { count: allDocuments.length },
      });
    });
    const docs = await this.prisma.candidatePreviousDocument.findMany({
      where: { candidateId: id },
      orderBy: { title: "asc" },
    });
    return {
      items: docs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        documentUid: doc.documentUid,
        fields: doc.fields,
        expiresAt: doc.expiresAt?.toISOString().slice(0, 10) ?? null,
        originalAvailable: doc.originalAvailable,
        status: doc.status,
        reviewedBy: doc.reviewedBy,
        reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      })),
      ...(historyPromise ? { employmentHistory: await historyPromise } : {}),
      ...(edoDocuments.length
        ? {
            edoDocuments: edoDocuments.map((doc) => ({
              id: doc.id,
              currentVersion: doc.currentVersion,
              status: doc.status,
              title: doc.documentType?.title ?? "Документ",
            })),
          }
        : {}),
    };
  }
  async recheck(
    id: string,
    documentId: string,
    p: AuthPrincipal,
    body: CandidateRecheckRequestDto,
  ) {
    // Refresh before granting confirmation: a failed ERP request must never
    // leave a stale document confirmed in the local projection.
    if (body.status === "CONFIRMED") await this.previous(id, p);
    const row = await this.previousOwner(id, p);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const current = await tx.candidate.findFirst({
        where: { id, ...this.access.candidateWhere(p) },
      });
      if (
        !current ||
        candidateReviewGroup(current) !== candidateReviewGroup(row) ||
        current.personUid !== row.personUid ||
        current.code1c !== row.code1c ||
        current.erpUid !== row.erpUid
      )
        throw new ConflictException("ERP_PERSON_IDENTITY_MISMATCH");
      requireReviewGroup(p, candidateReviewGroup(current));
      const doc = await tx.candidatePreviousDocument.findFirst({
        where: { id: documentId, candidateId: id },
      });
      if (!doc) throw new NotFoundException();
      if (
        body.status === "CONFIRMED" &&
        candidateReviewGroup(current) === "IG" &&
        (!doc.documentUid || needsNewIgDocument(doc.documentUid))
      )
        throw new ConflictException(
          "Для этого оформления нужна новая миграционная карта или патент. Если вид документа неизвестен, подтвердить его нельзя.",
        );
      if (body.status === "CONFIRMED" && !doc.originalAvailable)
        throw new ConflictException("Оригинал недоступен для проверки");
      if (
        body.status === "CONFIRMED" &&
        doc.fields &&
        typeof doc.fields === "object" &&
        !Array.isArray(doc.fields) &&
        doc.fields.isInvalid === true
      )
        throw new ConflictException("В ERP документ отмечен недействительным");
      if (
        body.status === "CONFIRMED" &&
        doc.expiresAt &&
        isPreviousDocumentExpired(doc.expiresAt)
      )
        throw new ConflictException("Срок действия документа истёк");
      await tx.candidatePreviousDocument.update({
        where: { id: documentId },
        data: {
          status: body.status,
          reviewedBy: p.uuid,
          reviewedAt: new Date(),
        },
      });
      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "DOCUMENT_FIELDS_UPDATED",
        entityType: "CandidatePreviousDocument",
        entityId: documentId,
        correlationId: "",
        before: { status: doc.status },
        after: { status: body.status },
      });
      if (body.status === "CONFIRMED" && candidateReviewGroup(current) === "IG")
        await tryCompleteIgEmployment(tx, this.audit, id, p.uuid, "");
    });
    return this.previous(id, p);
  }
  async original(id: string, documentId: string, p: AuthPrincipal) {
    const row = await this.previousOwner(id, p);
    const doc = await this.prisma.candidatePreviousDocument.findFirst({
      where: { id: documentId, candidateId: id },
    });
    if (!doc?.originalAvailable)
      throw new NotFoundException("Оригинал недоступен");
    if (candidateReviewGroup(row) === "IG" && doc.sourceId.startsWith("edo:")) {
      const parts = doc.sourceId.split(":");
      if (parts.length !== 3 || !this.ownHistory) throw new NotFoundException();
      const version = await this.prisma.documentVersion.findFirst({
        where: {
          id: parts[2],
          documentId: parts[1],
          document: { candidate: { code1c: row.code1c, chatUuid: null } },
        },
        include: {
          files: { where: { deletedAt: null }, orderBy: { ordinal: "asc" } },
        },
      });
      if (!version) throw new NotFoundException();
      return this.ownHistory.edoFile(
        row.code1c!,
        parts[1],
        version.files[0]?.id ?? `legacy-${version.id}`,
      );
    }
    return candidateReviewGroup(row) === "IG"
      ? this.erp.personOriginal(row.code1c!, row.personUid!, doc.sourceId)
      : this.erp.original(row.erpUid!, doc.sourceId);
  }
}
