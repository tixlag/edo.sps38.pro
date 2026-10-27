import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { DocumentAccessService } from "../documents/document-access.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import {
  AnnotationCatalogDto,
  AnnotationSectionInstanceDto,
  AnnotationDisposition,
  AnnotationDto,
  AnnotationQueryDto,
  AnnotationSourceKind,
  AnnotationStatus,
  ClaimAnnotationDto,
} from "./annotation.dto";
import {
  annotationAdmin,
  catalogDto,
  requireAnnotationAdmin,
} from "./annotation-catalog.service";
import {
  AnnotationSourceService,
  SourceManifest,
} from "./annotation-source.service";
import { validateDataset } from "./annotation-dataset-validation";
import { FieldAnswer, validateAnswers } from "./annotation-validation";
import { transitionAnnotation } from "./annotation-lifecycle";
const include = {
  version: {
    include: {
      document: { include: { candidate: { select: { code1c: true } } } },
    },
  },
  sections: { include: { pages: true } },
  fields: {
    include: {
      lines: { orderBy: { order: "asc" as const } },
      regions: {
        include: { vertices: { orderBy: { ordinal: "asc" as const } } },
      },
    },
    orderBy: { key: "asc" as const },
  },
};
type Row = Prisma.DocumentAnnotationGetPayload<{ include: typeof include }>;
const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function answers(row: Row): FieldAnswer[] {
  return row.fields.map((f) => ({
    key: f.key,
    instanceId: f.instanceId,
    regions: f.regions.map((r) => ({
      id: r.clientId,
      pageId: r.pageId,
      shape: r.shape as "RECTANGLE" | "POLYGON",
      orientationDeg: r.orientationDeg,
      polygon: r.vertices.flatMap((v) => [v.x, v.y]),
    })),
    disposition: f.disposition,
    lines: f.lines.map((l) => ({
      id: l.clientId,
      pageId: l.pageId,
      order: l.order,
      text: l.text,
      quad: [l.x0, l.y0, l.x1, l.y1, l.x2, l.y2, l.x3, l.y3],
    })),
  }));
}
@Injectable()
export class AnnotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: DocumentAccessService,
    private readonly sources: AnnotationSourceService,
  ) {}
  async preference(principal: AuthPrincipal) {
    const row = await this.prisma.annotationPreference.findUnique({
      where: { actorId: principal.uuid },
    });
    return { enabled: row?.enabled ?? false };
  }
  async setPreference(
    enabled: boolean,
    principal: AuthPrincipal,
    correlationId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.annotationPreference.findUnique({
        where: { actorId: principal.uuid },
      });
      const row = await tx.annotationPreference.upsert({
        where: { actorId: principal.uuid },
        create: { actorId: principal.uuid, enabled },
        update: { enabled },
      });
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "ANNOTATION_PREFERENCE_CHANGED",
        entityType: "AnnotationPreference",
        entityId: principal.uuid,
        before: { enabled: before?.enabled ?? false },
        after: { enabled },
        correlationId,
      });
      return { enabled: row.enabled };
    });
  }
  async list(query: AnnotationQueryDto, principal: AuthPrincipal) {
    const rows = await this.prisma.documentAnnotation.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        version: {
          ...(query.documentId ? { documentId: query.documentId } : {}),
          ...(query.version ? { version: query.version } : {}),
          document: this.access.documentReviewWhere(principal),
        },
      },
      include,
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return {
      items: await Promise.all(rows.map((row) => this.dto(row, principal))),
    };
  }
  private async lockDocument(
    tx: Prisma.TransactionClient,
    documentId: string,
  ): Promise<void> {
    const initial = await tx.document.findUnique({
      where: { id: documentId },
      select: { candidateId: true },
    });
    if (!initial) throw new NotFoundException("Document not found");
    if (initial.candidateId)
      await tx.$queryRaw`SELECT id FROM candidates WHERE id = ${initial.candidateId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`;
  }
  async claim(
    dto: ClaimAnnotationDto,
    principal: AuthPrincipal,
    correlationId?: string,
  ): Promise<AnnotationDto> {
    const manifest = await this.sources.manifest(
      dto.documentId,
      dto.version,
      principal,
    );
    const row = await this.prisma.$transaction(
      async (tx) => {
        await this.lockDocument(tx, dto.documentId);
        const version = await this.sources.version(
          dto.documentId,
          dto.version,
          principal,
          tx,
        );
        const existing = await tx.documentAnnotation.findUnique({
          where: { versionId: version.id },
          include,
        });
        if (existing) {
          if (existing.authorId !== principal.uuid)
            throw new ConflictException(
              "Annotation already has an active author",
            );
          return existing;
        }
        if (version.document.currentVersion !== dto.version)
          throw new ConflictException(
            "New annotation requires the current document version",
          );
        await this.sources.assertRetained(tx, manifest, principal);
        const catalog = await tx.annotationCatalog.findFirst({
          where: {
            id: dto.catalogId,
            status: "PUBLISHED",
            family: { documentTypeCode: manifest.documentTypeCode },
          },
          include: {
            family: true,
            sections: { orderBy: { ordinal: "asc" } },
            fields: { orderBy: { ordinal: "asc" } },
          },
        });
        if (!catalog)
          throw new ConflictException(
            "Список полей не соответствует типу документа",
          );
        const latest = await tx.annotationCatalog.findFirst({
          where: { familyId: catalog.familyId, status: "PUBLISHED" },
          orderBy: { version: "desc" },
        });
        if (latest?.id !== catalog.id)
          throw new ConflictException("Опубликована новая версия списка полей");
        const created = await tx.documentAnnotation.create({
          data: {
            versionId: version.id,
            catalogId: catalog.id,
            authorId: principal.uuid,
            schemaSnapshot: json(catalogDto(catalog)),
            sections: {
              create: catalog.sections.map((section) => ({
                clientId: section.key,
                sectionKey: section.key,
                availability: "NOT_UPLOADED",
              })),
            },
            sourceSnapshot: json(manifest),
          },
          include,
        });
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "ANNOTATION_CLAIMED",
          entityType: "DocumentAnnotation",
          entityId: created.id,
          after: {
            versionId: version.id,
            catalogId: catalog.id,
            authorId: principal.uuid,
          },
          correlationId,
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.dto(row, principal);
  }
  async mutate(
    id: string,
    operation: "save" | "submit" | "accept" | "changes" | "reassign",
    revision: number,
    principal: AuthPrincipal,
    options: {
      fields?: FieldAnswer[];
      sections?: AnnotationSectionInstanceDto[];
      note?: string;
      authorId?: string;
      correlationId?: string;
    } = {},
  ): Promise<AnnotationDto> {
    const initial = await this.prisma.documentAnnotation.findFirst({
      where: {
        id,
        version: { document: this.access.documentReviewWhere(principal) },
      },
      include,
    });
    if (!initial) throw new NotFoundException("Annotation not found");
    // Storage work is bounded and happens before taking database locks. Recheck source
    // liveness and scope under the document lock immediately before state mutation.
    transitionAnnotation(
      initial,
      operation,
      revision,
      principal.uuid,
      annotationAdmin(principal),
    );
    if (operation === "submit" || operation === "accept")
      await this.sources.verifyBytes(
        initial.sourceSnapshot as unknown as SourceManifest,
        principal,
      );
    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lockDocument(tx, initial.version.documentId);
        const row = await tx.documentAnnotation.findFirst({
          where: {
            id,
            version: { document: this.access.documentReviewWhere(principal) },
          },
          include,
        });
        if (!row) throw new NotFoundException("Annotation not found");
        const status = transitionAnnotation(
          row,
          operation,
          revision,
          principal.uuid,
          annotationAdmin(principal),
        );
        const manifest = row.sourceSnapshot as unknown as SourceManifest,
          schema = row.schemaSnapshot as unknown as AnnotationCatalogDto;
        if (operation !== "changes" && operation !== "reassign")
          await this.sources.assertRetained(tx, manifest, principal);
        const fields = validateAnswers(
          options.fields ?? answers(row),
          schema.fields,
          manifest.pages,
          operation === "submit" || operation === "accept",
          !!schema.sections?.length,
        );
        const sectionInstances =
          options.sections ??
          row.sections.map((s) => ({
            id: s.clientId,
            sectionKey: s.sectionKey,
            availability:
              s.availability as AnnotationSectionInstanceDto["availability"],
            pageIds: s.pages.map((p) => p.pageId),
          }));
        if (schema.sections?.length)
          validateDataset(
            fields,
            schema.fields,
            schema.sections,
            sectionInstances,
            manifest.pages,
            operation === "submit" || operation === "accept",
          );
        if (operation === "changes" && !options.note?.trim())
          throw new ConflictException("Explain the requested changes");
        if (operation === "reassign") {
          requireAnnotationAdmin(principal);
          if (!options.authorId?.trim() || options.authorId.length > 64)
            throw new ConflictException("A valid author is required");
        }
        const now = new Date();
        const changed = await tx.documentAnnotation.updateMany({
          where: {
            id,
            revision: row.revision,
            status: row.status,
            authorId: row.authorId,
          },
          data: {
            revision: { increment: 1 },
            status,
            ...(operation === "submit" ? { submittedAt: now, note: null } : {}),
            ...(operation === "accept" ? { acceptedAt: now } : {}),
            ...(operation === "changes" ? { note: options.note } : {}),
            ...(operation === "reassign"
              ? { authorId: options.authorId, submittedAt: null, note: null }
              : {}),
          },
        });
        if (changed.count !== 1)
          throw new ConflictException("Annotation revision changed");
        if (operation === "save") {
          await tx.annotationFieldAnswer.deleteMany({
            where: { annotationId: id },
          });
          await tx.annotationSectionInstance.deleteMany({
            where: { annotationId: id },
          });
          for (const section of sectionInstances)
            await tx.annotationSectionInstance.create({
              data: {
                annotationId: id,
                clientId: section.id,
                sectionKey: section.sectionKey,
                availability: section.availability,
                pages: {
                  create: section.pageIds.map((pageId) => ({ pageId })),
                },
              },
            });
          for (const field of fields)
            await tx.annotationFieldAnswer.create({
              data: {
                annotationId: id,
                key: field.key,
                instanceId: field.instanceId ?? "main",
                regions: {
                  create: (field.regions ?? []).map((r) => ({
                    clientId: r.id,
                    pageId: r.pageId,
                    shape: r.shape,
                    orientationDeg: r.orientationDeg,
                    vertices: {
                      create: Array.from(
                        { length: r.polygon.length / 2 },
                        (_, ordinal) => ({
                          ordinal,
                          x: r.polygon[ordinal * 2],
                          y: r.polygon[ordinal * 2 + 1],
                        }),
                      ),
                    },
                  })),
                },
                disposition: field.disposition,
                lines: {
                  create: field.lines.map((l) => ({
                    clientId: l.id,
                    pageId: l.pageId,
                    order: l.order,
                    text: l.text,
                    x0: l.quad[0],
                    y0: l.quad[1],
                    x1: l.quad[2],
                    y1: l.quad[3],
                    x2: l.quad[4],
                    y2: l.quad[5],
                    x3: l.quad[6],
                    y3: l.quad[7],
                  })),
                },
              },
            });
        }
        const next = await tx.documentAnnotation.findUniqueOrThrow({
          where: { id },
          include,
        });
        if (operation === "submit" || operation === "accept")
          await tx.annotationSnapshot.create({
            data: {
              annotationId: id,
              revision: next.revision,
              status,
              payload: json({
                annotation: {
                  id,
                  documentId: next.version.documentId,
                  candidateId: next.version.document.candidateId,
                  candidateCode1c:
                    next.version.document.candidate?.code1c ?? null,
                  versionId: next.versionId,
                  catalogId: next.catalogId,
                  authorId: next.authorId,
                  status,
                  revision: next.revision,
                },
                schema,
                sources: manifest,
                fields: answers(next),
                sections: next.sections.map((s) => ({
                  id: s.clientId,
                  sectionKey: s.sectionKey,
                  availability: s.availability,
                  pageIds: s.pages.map((p) => p.pageId),
                })),
              }),
            },
          });
        const action = {
          save: "ANNOTATION_SAVED",
          submit: "ANNOTATION_SUBMITTED",
          accept: "ANNOTATION_ACCEPTED",
          changes: "ANNOTATION_CHANGES_REQUESTED",
          reassign: "ANNOTATION_REASSIGNED",
        } as const;
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: action[operation],
          entityType: "DocumentAnnotation",
          entityId: id,
          before: {
            status: row.status,
            revision: row.revision,
            authorId: row.authorId,
            ...(operation === "save" ? { fields: answers(row) } : {}),
          },
          after: {
            status,
            revision: next.revision,
            authorId: next.authorId,
            ...(operation === "save" ? { fields: answers(next) } : {}),
            ...(operation === "changes" ? { note: options.note } : {}),
          },
          correlationId: options.correlationId,
        });
        return next;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return this.dto(result, principal);
  }
  private async dto(
    row: Row,
    principal: AuthPrincipal,
  ): Promise<AnnotationDto> {
    return {
      id: row.id,
      documentId: row.version.documentId,
      versionId: row.versionId,
      catalogId: row.catalogId,
      authorId: row.authorId,
      status: row.status as AnnotationStatus,
      revision: row.revision,
      sourceKind: AnnotationSourceKind.ORIGINAL,
      schema: row.schemaSnapshot as unknown as AnnotationCatalogDto,
      sources: await this.sources.publicDto(
        row.sourceSnapshot as unknown as SourceManifest,
        principal,
      ),
      sections: row.sections.map((s) => ({
        id: s.clientId,
        sectionKey: s.sectionKey,
        availability:
          s.availability as AnnotationSectionInstanceDto["availability"],
        pageIds: s.pages.map((p) => p.pageId),
      })),
      fields: answers(row).map((f) => ({
        ...f,
        disposition: f.disposition as AnnotationDisposition,
      })),
      note: row.note,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      editable:
        row.authorId === principal.uuid &&
        ["DRAFT", "CHANGES_REQUESTED"].includes(row.status),
    };
  }
}
