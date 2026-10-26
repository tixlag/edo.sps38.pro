import { DocumentCatalogService } from "../documents/document-catalog.service";
import { CandidateDocumentError } from "../documents/candidate-document.error";
import { CandidateDocumentErrorCode, CandidateProfileField } from "../documents/dto/candidate-error.dto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentAccessService } from "../documents/document-access.service";
import {
  candidateIdentityTransaction,
  resolveCandidateIdentity,
} from "../documents/candidate-identity";
import { requireReviewGroup } from "../documents/review-group";
import {
  ErpWorkspaceClient,
  erpCardSchema,
  previousDocumentsSchema,
  referencesSchema,
  type ErpCard,
} from "../documents/erp-workspace.client";
import {
  CandidatePersonLinkDto,
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
      throw new CandidateDocumentError(CandidateDocumentErrorCode.CANDIDATE_PROFILE_INCOMPLETE, [CandidateProfileField.POSITION_CODE]);
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
    const row = await this.owner(id, p);
    const result = await this.erp.request(
      "person-documents",
      previousDocumentsSchema,
      { candidate: row.erpUid! },
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      for (const doc of result.items)
        await tx.candidatePreviousDocument.upsert({
          where: {
            candidateId_sourceId: { candidateId: id, sourceId: doc.id },
          },
          create: {
            candidateId: id,
            sourceId: doc.id,
            documentUid: doc.documentUid,
            title: doc.title,
            fields: doc.fields as Prisma.InputJsonObject,
            expiresAt: doc.expiresAt
              ? new Date(`${doc.expiresAt.slice(0, 10)}T00:00:00Z`)
              : null,
            originalAvailable: doc.originalAvailable,
            status: doc.recheckStatus,
          },
          update: {
            title: doc.title,
            fields: doc.fields as Prisma.InputJsonObject,
            expiresAt: doc.expiresAt
              ? new Date(`${doc.expiresAt.slice(0, 10)}T00:00:00Z`)
              : null,
            originalAvailable: doc.originalAvailable,
          },
        });
      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "DATA_IMPORTED",
        entityType: "CandidatePreviousDocuments",
        entityId: id,
        correlationId: "",
        after: { count: result.items.length },
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
    };
  }
  async recheck(
    id: string,
    documentId: string,
    p: AuthPrincipal,
    body: CandidateRecheckRequestDto,
  ) {
    await this.owner(id, p);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${id} FOR UPDATE`;
      const doc = await tx.candidatePreviousDocument.findFirst({
        where: { id: documentId, candidateId: id },
      });
      if (!doc) throw new NotFoundException();
      if (body.status === "CONFIRMED" && !doc.originalAvailable)
        throw new ConflictException("Оригинал недоступен для проверки");
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
    });
    return this.previous(id, p);
  }
  async original(id: string, documentId: string, p: AuthPrincipal) {
    const row = await this.owner(id, p);
    const doc = await this.prisma.candidatePreviousDocument.findFirst({
      where: { id: documentId, candidateId: id },
    });
    if (!doc?.originalAvailable)
      throw new NotFoundException("Оригинал недоступен");
    return this.erp.original(row.erpUid!, doc.sourceId);
  }
}
