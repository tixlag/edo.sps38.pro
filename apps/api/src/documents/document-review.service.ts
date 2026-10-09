import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { DocumentAccessService } from "./document-access.service";
import { DocumentReadService } from "./document-read.service";

const editsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .refine((v) => !["__proto__", "constructor", "prototype"].includes(v)),
    z.string().max(16_384).nullable(),
  )
  .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 200);

@Injectable()
export class DocumentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentAccessService,
    private readonly audit: AuditService,
    private readonly reads: DocumentReadService,
  ) {}

  async edit(
    documentId: string,
    number: number,
    revision: number,
    fields: unknown,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    const parsed = editsSchema.safeParse(fields);
    if (!parsed.success)
      throw new BadRequestException("Invalid document fields");
    return this.change(
      documentId,
      number,
      revision,
      principal,
      correlationId,
      parsed.data,
    );
  }

  async approve(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
  ) {
    return this.change(documentId, number, revision, principal, correlationId);
  }

  private async change(
    documentId: string,
    number: number,
    revision: number,
    principal: AuthPrincipal,
    correlationId: string,
    edits?: Record<string, string | null>,
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        // Lock candidate first, matching ingestion's lock order. Recheck scope inside the transaction.
        const initial = await tx.document.findUnique({
          where: { id: documentId },
        });
        if (initial?.candidateId)
          await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${initial.candidateId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
        const doc = await tx.document.findFirst({
          where: { id: documentId, ...this.access.documentWhere(principal) },
        });
        if (!doc) {
          // Reuse the same 404 for inaccessible documents.
          throw new NotFoundException("Document not found");
        }
        const version = await tx.documentVersion.findUnique({
          where: { documentId_version: { documentId, version: number } },
          include: { fields: true },
        });
        if (
          !version ||
          doc.currentVersion !== number ||
          version.status !== "IN_REVIEW" ||
          version.revision !== revision
        ) {
          throw new ConflictException(
            "Document version or review revision has changed",
          );
        }
        const changed = await tx.documentVersion.updateMany({
          where: { id: version.id, revision, status: "IN_REVIEW" },
          data: {
            revision: { increment: 1 },
            ...(edits
              ? {}
              : {
                  status: "APPROVED",
                  approvedAt: new Date(),
                  approvedBy: principal.uuid,
                }),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("Review revision has changed");
        if (edits) {
          const names = new Set([
            ...version.fields.map((f) => f.name),
            ...Object.keys(edits),
          ]);
          if (names.size > 200)
            throw new BadRequestException("At most 200 document fields");
          for (const [name, value] of Object.entries(edits)) {
            await tx.documentVersionField.upsert({
              where: { versionId_name: { versionId: version.id, name } },
              create: {
                versionId: version.id,
                name,
                originalValue: null,
                value,
                editedBy: principal.uuid,
              },
              update: { value, editedBy: principal.uuid },
            });
          }
        } else {
          await tx.document.update({
            where: { id: documentId },
            data: { status: "APPROVED" },
          });
        }
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: edits ? "DOCUMENT_FIELDS_UPDATED" : "DOCUMENT_APPROVED",
          entityType: "Document",
          entityId: documentId,
          correlationId: correlationId.slice(0, 64),
          before: {
            version: number,
            revision,
            fields: version.fields.map(({ name, value }) => ({ name, value })),
          },
          after: {
            version: number,
            revision: revision + 1,
            ...(edits ? { fields: edits } : { status: "APPROVED" }),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.reads.version(documentId, number);
  }
}
