import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { AuthPrincipal } from "../auth/auth-principal";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { DocumentAccessService } from "./document-access.service";
import { candidateGroupAccessWhere, candidateReviewGroup, requireReviewGroup } from "./review-group";
import { DocumentUploadService } from "./document-upload.service";
import { ManualDocumentService } from "./manual-document.service";
import { DocumentCatalogService } from "./document-catalog.service";
import { FIELD_LABELS, fieldKind, textValue, typedValue, validateFields } from "./document-contract";
import { previousDocumentAvailability } from "./previous-document-availability";
import { applyPreviousDocumentEdits } from "./previous-document-edits";
import { tryCompleteIgEmployment } from "./ig-completion";
import type { PreviousDocumentDetailsDto } from "./dto/reviewer-document.dto";
import type { EditDocumentFieldsDto } from "./dto/document.dto";

@Injectable()
export class ReviewerDocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly access: DocumentAccessService,
    private readonly uploads: DocumentUploadService, private readonly manual: ManualDocumentService,
    private readonly catalog: DocumentCatalogService, private readonly audit: AuditService) {}

  private async owner(id: string, principal: AuthPrincipal) {
    const owner = await this.access.candidate(id, principal);
    requireReviewGroup(principal, candidateReviewGroup(owner));
    return owner;
  }
  async types(id: string, principal: AuthPrincipal) {
    const owner = await this.owner(id, principal);
    return this.catalog.list(owner.positionCode ?? "", owner.citizenship ?? "ru",
      owner.sexKnown && (owner.sex === "male" || owner.sex === "female") ? owner.sex : null, owner.projectCode);
  }
  async upload(id: string, principal: AuthPrincipal, req: Parameters<DocumentUploadService["parse"]>[0], key: string | undefined, correlationId: string) {
    const owner = await this.owner(id, principal);
    if (candidateReviewGroup(owner) === "RU" ? !owner.erpUid : !owner.personUid || !owner.code1c)
      throw new ConflictException("ERP_DOCUMENT_RECIPIENT_REQUIRED");
    const upload = await this.uploads.parse(req, undefined, true);
    try {
      if (upload.metadata) throw new BadRequestException("Reviewer upload accepts documentTypeCode and files only");
      const type = await this.prisma.documentType.findUnique({ where: { code: upload.documentTypeCode } });
      if (!type?.erpUid) throw new BadRequestException("Unknown document type");
      upload.metadata = { documentUid: type.erpUid, position_code_1c: owner.positionCode ?? "",
        citizenship: owner.citizenship ?? "ru", project_code_1c: owner.projectCode ?? undefined,
        documentFields: {} };
      return await this.manual.upload(upload, key ?? upload.idempotencyKey, correlationId, { candidateId: id, principal });
    } finally { await this.uploads.dispose(upload); }
  }
  async assertReviewerDelivery(candidateId: string, documentId: string, version: number, principal: AuthPrincipal) {
    await this.owner(candidateId, principal);
    const row = await this.prisma.documentVersion.findFirst({ where: { documentId, version,
      document: { candidateId }, submission: { origin: "REVIEWER" } } });
    if (!row) throw new NotFoundException("REVIEWER_UPLOAD_NOT_FOUND");
  }
  private async load(tx: Prisma.TransactionClient, candidateId: string, id: string) {
    const row = await tx.candidatePreviousDocument.findFirst({ where: { id, candidateId }, include: { fieldEdits: true } });
    if (!row) throw new NotFoundException("PREVIOUS_DOCUMENT_NOT_FOUND");
    const type = row.documentUid ? await tx.documentType.findUnique({ where: { erpUid: row.documentUid }, include: { definitions: true } }) : null;
    const erp = (row.erpFields ?? row.fields) as Record<string, unknown>;
    const definitions = new Map((type?.definitions ?? []).map((field) => [field.name, field]));
    for (const name of Object.keys(erp)) {
      if (!/^(?:recordDate|sourceId|.*uuid.*|.*uid.*|code_?1c|id)$/i.test(name) && FIELD_LABELS[name] && !definitions.has(name))
        definitions.set(name, { name, kind: fieldKind(name), required: false, ordinal: definitions.size } as never);
    }
    return { row, type, erp, definitions: [...definitions.values()].sort((a, b) => a.ordinal - b.ordinal) };
  }
  async details(candidateId: string, id: string, principal: AuthPrincipal): Promise<PreviousDocumentDetailsDto> {
    const owner = await this.owner(candidateId, principal);
    const { row, type, erp, definitions } = await this.load(this.prisma, candidateId, id);
    const document = previousDocumentAvailability([{ code: type?.code ?? "", title: row.title,
      erpUid: row.documentUid, category: "required" }], [row], [], candidateReviewGroup(owner) === "IG")[0];
    if (!document) throw new ConflictException("PREVIOUS_DOCUMENT_TYPE_REQUIRED");
    const values = row.fields as Record<string, unknown>;
    return { document, revision: row.localRevision, hasLocalEdits: row.fieldEdits.length > 0,
      fields: definitions.map((field) => ({ id: `${id}:${field.name}`, name: field.name,
        label: FIELD_LABELS[field.name] ?? field.name, kind: field.kind, required: field.required,
        value: textValue(values[field.name] as string | boolean | null),
        originalValue: textValue(erp[field.name] as string | boolean | null), edited: row.fieldEdits.some((edit) => edit.name === field.name),
        submittedValue: textValue(erp[field.name] as string | boolean | null),
        editedBy: row.fieldEdits.find((edit) => edit.name === field.name)?.editedBy ?? null,
        mismatch: false, regions: [] })) };
  }
  async edit(candidateId: string, id: string, body: EditDocumentFieldsDto, principal: AuthPrincipal, correlationId: string) {
    await this.owner(candidateId, principal);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM candidates WHERE id=${candidateId} FOR UPDATE`;
      const owner = await tx.candidate.findFirst({ where: { id: candidateId, ...candidateGroupAccessWhere(principal, true) } });
      if (!owner) throw new NotFoundException("CANDIDATE_NOT_FOUND");
      requireReviewGroup(principal, candidateReviewGroup(owner));
      const { row, erp, definitions } = await this.load(tx, candidateId, id);
      if (row.localRevision !== body.revision) throw new ConflictException("Document fields changed; reload before saving");
      const fields = body.fields;
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length > 200)
        throw new BadRequestException("Invalid document fields");
      validateFields(definitions, fields);
      for (const [name, value] of Object.entries(fields)) {
        const kind = definitions.find((definition) => definition.name === name)!.kind;
        await tx.candidatePreviousDocumentFieldEdit.upsert({
          where: { previousDocumentId_name: { previousDocumentId: id, name } },
          create: { previousDocumentId: id, name, value: textValue(value), kind, editedBy: principal.uuid },
          update: { value: textValue(value), kind, editedBy: principal.uuid, editedAt: new Date() },
        });
      }
      const edits = await tx.candidatePreviousDocumentFieldEdit.findMany({ where: { previousDocumentId: id } });
      const effective = applyPreviousDocumentEdits(erp, edits);
      const expiry = edits.find((edit) => edit.name === "expiryDate");
      const expiresAt = expiry ? expiry.value ? new Date(`${expiry.value}T00:00:00Z`) : null : row.expiresAt;
      await tx.candidatePreviousDocument.update({ where: { id }, data: {
        erpFields: erp as Prisma.InputJsonObject, fields: effective as Prisma.InputJsonObject, expiresAt,
        localRevision: { increment: 1 },
      } });
      if (candidateReviewGroup(owner) === "IG") {
        await tx.candidate.updateMany({ where: { id: candidateId }, data: { igCompletionVerified: false } });
        await tryCompleteIgEmployment(tx, this.audit, candidateId, principal.uuid, correlationId);
      }
      await this.audit.logInTransaction(tx, { actorId: principal.uuid, action: "DOCUMENT_FIELDS_UPDATED",
        entityType: "CandidatePreviousDocument", entityId: id, correlationId,
        before: row.fields, after: { fields: effective, localOnly: true } });
    });
    return this.details(candidateId, id, principal);
  }
}
