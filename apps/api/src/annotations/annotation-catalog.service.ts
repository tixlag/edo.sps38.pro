import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { hasAccessRule } from "../auth/access-rules";
import { EdoAccessRule } from "../auth/edo-access-rule";
import {
  AnnotationCatalogDto,
  AnnotationCatalogQueryDto,
  AnnotationCatalogSuggestionDto,
  CatalogStatus,
  CreateAnnotationCatalogDto,
  SuggestionStatus,
  UpdateAnnotationCatalogDto,
} from "./annotation.dto";
import { ANNOTATION_PRESETS, annotationPreset } from "./annotation-presets";
import {
  annotationKey,
  validateSections,
} from "./annotation-dataset-validation";
import { DocumentCatalogService } from "../documents/document-catalog.service";
import { AnnotationFieldKind } from "./annotation.dto";
import { validateCatalogFields } from "./annotation-validation";
const include = {
  family: true,
  sections: { orderBy: { ordinal: "asc" as const } },
  fields: { orderBy: { ordinal: "asc" as const } },
};
type CatalogRow = Prisma.AnnotationCatalogGetPayload<{
  include: typeof include;
}>;
export function annotationAdmin(principal: AuthPrincipal): boolean {
  return hasAccessRule(principal.accessRules, EdoAccessRule.FULL_ACCESS);
}
export function requireAnnotationAdmin(principal: AuthPrincipal): void {
  if (!annotationAdmin(principal))
    throw new ForbiddenException(
      "Annotation administration requires full access",
    );
}
export function catalogDto(row: CatalogRow): AnnotationCatalogDto {
  return {
    id: row.id,
    documentTypeCode: row.family.documentTypeCode,
    profile: row.family.profile,
    title: row.title,
    version: row.version,
    status: row.status as CatalogStatus,
    revision: row.revision,
    sections: row.sections ?? [],
    fields: row.fields.map((f) => ({
      sectionKey: f.sectionKey,
      kind: f.kind as AnnotationFieldKind,
      key: f.key,
      label: f.label,
      ordinal: f.ordinal,
      multiline: f.multiline,
      businessFieldName: null,
    })),
  };
}
@Injectable()
export class AnnotationCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly documentCatalog?: DocumentCatalogService,
  ) {}
  async list(query: AnnotationCatalogQueryDto, principal: AuthPrincipal) {
    const items = await this.prisma.annotationCatalog.findMany({
      where: {
        ...(annotationAdmin(principal) ? {} : { status: "PUBLISHED" }),
        family: {
          ...(query.documentTypeCode
            ? { documentTypeCode: query.documentTypeCode }
            : {}),
          ...(query.profile ? { profile: query.profile } : {}),
        },
      },
      include,
      orderBy: [{ familyId: "asc" }, { version: "desc" }],
      take: 500,
    });
    return { items: items.map(catalogDto) };
  }
  async create(
    dto: CreateAnnotationCatalogDto,
    principal: AuthPrincipal,
    correlationId?: string,
    initialize = false,
  ) {
    requireAnnotationAdmin(principal);
    if (
      !annotationPreset(dto.documentTypeCode) &&
      !(await this.prisma.documentType.findUnique({
        where: { code: dto.documentTypeCode },
      }))
    )
      throw new NotFoundException("Тип документа не найден");
    const sections = dto.sections ? validateSections(dto.sections) : [];
    const fields = validateCatalogFields(dto.fields).map((field) => ({
      ...field,
      businessFieldName: null,
    }));
    if (
      sections.length &&
      fields.some(
        (f) => !sections.some((s) => s.key === (f.sectionKey ?? "main")),
      )
    )
      throw new ConflictException("Выберите раздел для каждого поля");
    const profile = dto.profile || annotationKey(dto.title, new Set());
    return this.prisma.$transaction(
      async (tx) => {
        requireAnnotationAdmin(principal);
        const family = await tx.annotationCatalogFamily.upsert({
          where: {
            documentTypeCode_profile: {
              documentTypeCode: dto.documentTypeCode,
              profile,
            },
          },
          create: {
            documentTypeCode: dto.documentTypeCode,
            profile,
          },
          update: {},
        });
        await tx.$queryRaw`SELECT id FROM annotation_catalog_families WHERE id = ${family.id} FOR UPDATE`;
        if (
          initialize &&
          (await tx.annotationCatalog.count({ where: { familyId: family.id } }))
        )
          throw new ConflictException("Список уже настроен");
        if (
          await tx.annotationCatalog.findFirst({
            where: { familyId: family.id, status: "DRAFT" },
          })
        )
          throw new ConflictException("Catalog draft already exists");
        const max = await tx.annotationCatalog.aggregate({
          where: { familyId: family.id },
          _max: { version: true },
        });
        const row = await tx.annotationCatalog.create({
          data: {
            familyId: family.id,
            version: (max._max.version ?? 0) + 1,
            title: dto.title,
            ...(initialize
              ? {
                  status: "PUBLISHED",
                  draftSlot: null,
                  publishedAt: new Date(),
                }
              : {}),
            fields: { create: fields },
            sections: { create: sections },
          },
          include,
        });
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "ANNOTATION_CATALOG_CHANGED",
          entityType: "AnnotationCatalog",
          entityId: row.id,
          after: catalogDto(row),
          correlationId,
        });
        return catalogDto(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
  async mutate(
    id: string,
    revision: number,
    dto: UpdateAnnotationCatalogDto | undefined,
    publish: boolean,
    remove: boolean,
    principal: AuthPrincipal,
    correlationId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      requireAnnotationAdmin(principal);
      const row = await tx.annotationCatalog.findUnique({
        where: { id },
        include,
      });
      if (!row) throw new NotFoundException("Catalog not found");
      if (row.status !== "DRAFT" || row.revision !== revision)
        throw new ConflictException("Catalog is published or revision changed");
      const fields = dto
        ? validateCatalogFields(dto.fields).map((field) => ({
            ...field,
            businessFieldName: null,
          }))
        : row.fields;
      const sections = dto?.sections
        ? validateSections(dto.sections)
        : (row.sections ?? []);
      if (
        sections.length &&
        fields.some(
          (f) => !sections.some((s) => s.key === (f.sectionKey ?? "main")),
        )
      )
        throw new ConflictException("Выберите раздел для каждого поля");
      if (publish) validateCatalogFields(fields);
      // A CAS protects both publication and replacement of relational field rows.
      const result = await tx.annotationCatalog.updateMany({
        where: { id, revision, status: "DRAFT" },
        data: {
          revision: { increment: 1 },
          ...(dto ? { title: dto.title } : {}),
          ...(publish
            ? { status: "PUBLISHED", draftSlot: null, publishedAt: new Date() }
            : {}),
        },
      });
      if (result.count !== 1)
        throw new ConflictException("Catalog revision changed");
      if (remove) {
        await tx.annotationCatalog.delete({ where: { id } });
        await this.audit.logInTransaction(tx, {
          actorId: principal.uuid,
          action: "ANNOTATION_CATALOG_CHANGED",
          entityType: "AnnotationCatalog",
          entityId: id,
          before: catalogDto(row),
          after: { deleted: true },
          correlationId,
        });
        return { deleted: true };
      }
      if (dto) {
        await tx.annotationCatalogSection.deleteMany({
          where: { catalogId: id },
        });
        if (sections.length)
          await tx.annotationCatalogSection.createMany({
            data: sections.map((s) => ({ ...s, catalogId: id })),
          });
        await tx.annotationCatalogField.deleteMany({
          where: { catalogId: id },
        });
        await tx.annotationCatalogField.createMany({
          data: fields.map((f) => ({
            catalogId: id,
            sectionKey: f.sectionKey ?? "main",
            kind: f.kind ?? "TEXT",
            key: f.key,
            label: f.label,
            ordinal: f.ordinal,
            multiline: f.multiline ?? false,
            businessFieldName: f.businessFieldName ?? null,
          })),
        });
      }
      const next = await tx.annotationCatalog.findUniqueOrThrow({
        where: { id },
        include,
      });
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "ANNOTATION_CATALOG_CHANGED",
        entityType: "AnnotationCatalog",
        entityId: id,
        before: catalogDto(row),
        after: catalogDto(next),
        correlationId,
      });
      return catalogDto(next);
    });
  }
  async defaults(
    documentTypeCode: string,
    principal: AuthPrincipal,
    profile?: string,
  ) {
    requireAnnotationAdmin(principal);
    const type = await this.prisma.documentType.findUnique({
      where: { code: documentTypeCode },
    });
    const preset = annotationPreset(documentTypeCode, profile);
    if (!type && !preset)
      throw new NotFoundException("Тип документа не найден");
    return {
      fields: preset?.fields ?? [],
      sections: preset?.sections ?? [
        {
          key: "main",
          label: "Основной документ",
          ordinal: 0,
          repeatable: false,
        },
      ],
      title: preset?.title ?? type!.title,
      profile: preset?.profile ?? "",
    };
  }
  async documentTypes(principal: AuthPrincipal, refresh = false) {
    requireAnnotationAdmin(principal);
    if (refresh) await this.bootstrap(principal);
    const result =
      refresh && this.documentCatalog
        ? await this.documentCatalog.refreshForAnnotations()
        : { stale: false };
    const items = await this.prisma.documentType.findMany({
      where: { catalogSyncedAt: { not: null } },
      orderBy: { title: "asc" },
    });
    const types = new Map<string, { code: string; title: string }>();
    for (const preset of ANNOTATION_PRESETS) {
      if (!types.has(preset.documentTypeCode))
        types.set(preset.documentTypeCode, {
          code: preset.documentTypeCode,
          title:
            preset.documentTypeCode === "PASSPORT"
              ? "Паспорт"
              : preset.documentTypeCode === "SNILS"
                ? "СНИЛС"
                : preset.title,
        });
    }
    for (const item of items)
      types.set(item.code, { code: item.code, title: item.title.trim() });
    const dates = items.map((t) => t.catalogSyncedAt?.getTime() ?? 0);
    return {
      items: [...types.values()].sort((a, b) =>
        a.title.localeCompare(b.title, "ru"),
      ),
      syncedAt: Math.max(0, ...dates)
        ? new Date(Math.max(...dates)).toISOString()
        : null,
      stale: result.stale || !items.length,
    };
  }
  async bootstrap(principal: AuthPrincipal) {
    requireAnnotationAdmin(principal);
    let created = 0,
      skipped = 0;
    for (const preset of ANNOTATION_PRESETS) {
      const existing = await this.prisma.annotationCatalogFamily.findUnique({
        where: {
          documentTypeCode_profile: {
            documentTypeCode: preset.documentTypeCode,
            profile: preset.profile,
          },
        },
        include: { catalogs: true },
      });
      if (existing?.catalogs.length) {
        skipped++;
        continue;
      }
      try {
        await this.create(preset, principal, undefined, true);
        created++;
      } catch (error) {
        if (
          error instanceof ConflictException ||
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002")
        ) {
          skipped++;
          continue;
        }
        throw error;
      }
    }
    return { created, skipped };
  }
  async suggestions(id: string, principal: AuthPrincipal) {
    const catalog = await this.prisma.annotationCatalog.findUnique({
      where: { id },
    });
    if (
      !catalog ||
      (!annotationAdmin(principal) && catalog.status !== "PUBLISHED")
    )
      throw new NotFoundException("Catalog not found");
    const rows = await this.prisma.annotationCatalogSuggestion.findMany({
      where: {
        catalogId: id,
        ...(annotationAdmin(principal) ? {} : { authorId: principal.uuid }),
      },
      take: 500,
      orderBy: { createdAt: "desc" },
    });
    return {
      items: rows.map((r) => ({
        ...r,
        status: r.status as SuggestionStatus,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
  async suggest(
    id: string,
    key: string,
    label: string,
    principal: AuthPrincipal,
    correlationId?: string,
  ): Promise<AnnotationCatalogSuggestionDto> {
    if (!/^[-a-zA-Z0-9_]{1,64}$/.test(key))
      throw new BadRequestException("Invalid suggestion key");
    return this.prisma.$transaction(async (tx) => {
      const catalog = await tx.annotationCatalog.findUnique({ where: { id } });
      if (!catalog || catalog.status !== "PUBLISHED")
        throw new NotFoundException("Published catalog not found");
      const row = await tx.annotationCatalogSuggestion.create({
        data: { catalogId: id, authorId: principal.uuid, key, label },
      });
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "ANNOTATION_CATALOG_CHANGED",
        entityType: "AnnotationCatalogSuggestion",
        entityId: row.id,
        after: { catalogId: id, key, label },
        correlationId,
      });
      return {
        ...row,
        status: row.status as SuggestionStatus,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
  async resolve(
    catalogId: string,
    id: string,
    status: SuggestionStatus,
    principal: AuthPrincipal,
    correlationId?: string,
  ): Promise<AnnotationCatalogSuggestionDto> {
    return this.prisma.$transaction(async (tx) => {
      requireAnnotationAdmin(principal);
      if (!["APPLIED", "DISMISSED"].includes(status))
        throw new BadRequestException("Invalid resolution");
      const row = await tx.annotationCatalogSuggestion.findFirst({
        where: { id, catalogId, status: "PENDING" },
        include: { catalog: true },
      });
      if (!row) throw new NotFoundException("Pending suggestion not found");
      if (
        status === "APPLIED" &&
        !(await tx.annotationCatalogField.findFirst({
          where: {
            key: row.key,
            catalog: {
              familyId: row.catalog.familyId,
              status: "PUBLISHED",
              version: { gt: row.catalog.version },
            },
          },
        }))
      )
        throw new ConflictException("Apply the field to a newer catalog first");
      const changed = await tx.annotationCatalogSuggestion.updateMany({
        where: { id, status: "PENDING" },
        data: { status },
      });
      if (changed.count !== 1)
        throw new ConflictException("Suggestion changed");
      await this.audit.logInTransaction(tx, {
        actorId: principal.uuid,
        action: "ANNOTATION_CATALOG_CHANGED",
        entityType: "AnnotationCatalogSuggestion",
        entityId: id,
        before: { status: row.status },
        after: { status },
        correlationId,
      });
      return {
        id: row.id,
        catalogId,
        authorId: row.authorId,
        key: row.key,
        label: row.label,
        status,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}
