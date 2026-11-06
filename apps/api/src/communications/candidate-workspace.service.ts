import { DocumentCatalogService } from "../documents/document-catalog.service";
import { CandidatePreviousDocumentsSyncService } from "../documents/candidate-previous-documents-sync.service";
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
  referencesSchema,
  personMatchesSchema,
  type ErpCard,
} from "../documents/erp-workspace.client";
import {
  CandidatePersonLinkDto,
  CandidatePersonMatchQueryDto,
  CandidateStatusRequestDto,
  CreateCandidateDto,
  UpdateCandidateDto,
} from "./candidate-workspace.dto";
import { ErpCandidateClient } from "../documents/erp-candidate.client";
import type { Candidate, Prisma } from "@prisma/client";

@Injectable()
export class CandidateWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpWorkspaceClient,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly catalog: DocumentCatalogService,
    private readonly previousDocsSync: CandidatePreviousDocumentsSyncService,
    @Optional() private readonly ownHistory?: OwnDocumentHistoryService,
    @Optional() private readonly candidates?: ErpCandidateClient,
  ) {}
  private actor(p: AuthPrincipal) {
    requireReviewGroup(p, "RU");
    if (!p.code1c) throw new ForbiddenException("ERP_ACTOR_IDENTITY_REQUIRED");
    return p.code1c;
  }
  private async owner(id: string, p: AuthPrincipal) {
    requireReviewGroup(p, "RU");
    let row = await this.access.candidate(id, p);
    if (candidateReviewGroup(row) !== "RU")
      throw new ConflictException("ERP_CANDIDATE_CONFIRMATION_REQUIRED");
    if (!row.erpUid && row.chatUuid && this.candidates) {
      row = await this.healCandidateFromErp(row, p);
    }
    if (!row.erpUid)
      throw new ConflictException("ERP_CANDIDATE_CONFIRMATION_REQUIRED");
    return row;
  }

  private async healCandidateFromErp(
    row: Candidate,
    p: AuthPrincipal,
  ): Promise<Candidate> {
    if (!this.candidates || !row.chatUuid) return row;
    let erpUid: string | undefined;
    let code1c: string | undefined;
    try {
      if (typeof this.candidates.resolveIdentityByChat === "function") {
        erpUid = await this.candidates.resolveIdentityByChat(row.chatUuid);
      }
      if (!row.code1c || !erpUid) {
        try {
          if (typeof this.candidates.findByChatUuid === "function") {
            const snapshot = await this.candidates.findByChatUuid(row.chatUuid);
            if (snapshot.erpUid) erpUid = snapshot.erpUid;
            if (snapshot.code1C) code1c = snapshot.code1C;
            else if (snapshot.code1c) code1c = snapshot.code1c;
          }
        } catch {
          // Non-blocking if profile is incomplete
        }
      }
    } catch {
      return row;
    }
    if (!erpUid) return row;

    return this.prisma.$transaction(async (tx) => {
      const ghost = await tx.candidate.findFirst({
        where: {
          erpUid,
          id: { not: row.id },
          chatUuid: null,
        },
        include: { _count: { select: { documents: true } } },
      });

      let ghostMeta: Prisma.CandidateUpdateInput = {};
      if (ghost && (ghost as any)._count?.documents === 0) {
        ghostMeta = {
          ...(ghost.statusId && !row.statusId ? { statusId: ghost.statusId } : {}),
          ...(ghost.statusName && !row.statusName ? { statusName: ghost.statusName } : {}),
          ...(ghost.managerId && !row.managerId ? { managerId: ghost.managerId } : {}),
          ...(ghost.managerName && !row.managerName ? { managerName: ghost.managerName } : {}),
          ...(ghost.projectCode && !row.projectCode ? { projectCode: ghost.projectCode } : {}),
          ...(ghost.projectName && !row.projectName ? { projectName: ghost.projectName } : {}),
          ...(ghost.positionCode && !row.positionCode ? { positionCode: ghost.positionCode } : {}),
          ...(ghost.positionName && !row.positionName ? { positionName: ghost.positionName } : {}),
          ...(ghost.code1c && !row.code1c ? { code1c: ghost.code1c } : {}),
          ...(ghost.personUid && !row.personUid ? { personUid: ghost.personUid } : {}),
        };
        await tx.candidate.delete({ where: { id: ghost.id } });
      }

      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${row.id} FOR UPDATE`;
      const updated = await tx.candidate.update({
        where: { id: row.id },
        data: {
          erpUid,
          reviewGroup: "RU",
          ...(code1c && !row.code1c ? { code1c } : {}),
          ...ghostMeta,
        },
      });

      await this.audit.logInTransaction(tx, {
        actorId: p.uuid,
        action: "CANDIDATE_LINKED",
        entityType: "Candidate",
        entityId: row.id,
        correlationId: "",
        before: { erpUid: row.erpUid, reviewGroup: row.reviewGroup },
        after: { erpUid, reviewGroup: "RU" },
      });

      return updated;
    });
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
      identity.code1C !== row.code1c ||
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
    return this.syncPreviousDocumentsInternal(id, p.uuid, "", row, p);
  }

  async syncPreviousDocumentsInternal(
    id: string,
    actorId: string,
    correlationId = "",
    preloadedRow?: any,
    p?: AuthPrincipal,
  ) {
    return this.previousDocsSync.syncPreviousDocuments(
      id,
      actorId,
      correlationId,
      preloadedRow,
      p,
    );
  }
  async original(id: string, documentId: string, p: AuthPrincipal) {
    const row = await this.previousOwner(id, p);
    let doc = await this.prisma.candidatePreviousDocument.findFirst({
      where: { id: documentId, candidateId: id },
    });
    if (!doc) {
      doc = await this.prisma.candidatePreviousDocument.findFirst({
        where: {
          candidateId: id,
          OR: [
            { sourceId: documentId },
            { sourceId: { startsWith: `edo:${documentId}:` } },
          ],
        },
      });
    }
    if (doc) {
      if (!doc.originalAvailable)
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
    if (candidateReviewGroup(row) === "IG" && this.ownHistory) {
      const historicalDoc = await this.prisma.document.findFirst({
        where: {
          id: documentId,
          candidate: {
            code1c: row.code1c,
            chatUuid: null,
            AND: [
              { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
              { OR: [{ personUid: null }, { personUid: row.personUid }] },
            ],
          },
        },
        include: {
          versions: {
            include: {
              files: { where: { deletedAt: null }, orderBy: { ordinal: "asc" } },
            },
            orderBy: { version: "desc" },
          },
        },
      });
      if (historicalDoc) {
        const version =
          historicalDoc.versions.find(
            (v) => v.version === historicalDoc.currentVersion,
          ) ?? historicalDoc.versions[0];
        if (version && (version.files.length > 0 || version.storageKey)) {
          return this.ownHistory.edoFile(
            row.code1c!,
            historicalDoc.id,
            version.files[0]?.id ?? `legacy-${version.id}`,
          );
        }
      }
    }
    throw new NotFoundException("Оригинал недоступен");
  }
}
