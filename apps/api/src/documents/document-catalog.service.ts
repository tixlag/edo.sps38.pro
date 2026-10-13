import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import {
  applicable,
  erpCatalogSchema,
  FIELD_LABELS,
  fieldKind,
} from "./document-contract";
import { erpDocumentHeaders } from "./erp-document-auth";

const LEGACY_CODES: Record<string, string> = {
  "6ffb1fd5-8341-11eb-ba8b-00259002db81": "PASSPORT",
  "f97a4962-8c32-11eb-ba8b-00259002db81": "SNILS",
  "2452c57b-8c32-11eb-ba8b-00259002db81": "INN",
  "6d5f0835-8c54-11eb-ba8b-00259002db81": "MILITARY",
  "5a339bce-4386-11ec-80c9-002590854e7f": "BANK_DETAILS",
};
@Injectable()
export class DocumentCatalogService {
  private refreshPromise?: Promise<void>;
  private nextRefresh = 0;
  private readonly logger = new Logger(DocumentCatalogService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  async ensure(): Promise<void> {
    if (Date.now() >= this.nextRefresh) {
      this.refreshPromise ??= this.refresh().finally(() => {
        this.refreshPromise = undefined;
      });
      await this.refreshPromise;
    }
    if (
      !(await this.prisma.documentType.count({
        where: { catalogSyncedAt: { not: null } },
      }))
    )
      throw new ServiceUnavailableException("ERP_DOCUMENT_CATALOG_UNAVAILABLE");
  }
  private async refresh(): Promise<void> {
    this.nextRefresh = Date.now() + 60_000;
    const token = this.config.get<string>("ERP_DOCUMENTS_TOKEN");
    if (!token) return;
    try {
      const url = new URL(
        "documents-by-positions",
        this.config.get<string>("ERP_DOCUMENTS_BASE_URL"),
      );
      const response = await fetch(url, {
        headers: {
          ...erpDocumentHeaders(this.config),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`ERP_HTTP_${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024)
        throw new Error("ERP_CATALOG_TOO_LARGE");
      const catalog = erpCatalogSchema.parse(JSON.parse(body));
      await this.prisma.$transaction(
        async (tx) => {
          const now = new Date();
          for (const item of catalog) {
            const type = await tx.documentType.upsert({
              where: {
                code:
                  LEGACY_CODES[item.УИНДокумента] ?? `ERP_${item.УИНДокумента}`,
              },
              create: {
                code:
                  LEGACY_CODES[item.УИНДокумента] ?? `ERP_${item.УИНДокумента}`,
                title: item.НаименованиеДокумента,
                erpUid: item.УИНДокумента,
                allRu: item.ВсемРФ,
                allForeign: item.ВсемИГ,
                catalogSyncedAt: now,
              },
              update: {
                title: item.НаименованиеДокумента,
                erpUid: item.УИНДокумента,
                allRu: item.ВсемРФ,
                allForeign: item.ВсемИГ,
                catalogSyncedAt: now,
              },
            });
            await tx.documentTypeField.deleteMany({
              where: { documentTypeId: type.id },
            });
            await tx.documentTypePosition.deleteMany({
              where: { documentTypeId: type.id },
            });
            await tx.documentTypeField.createMany({
              data: [...item.requiredFields, ...item.optionalFields].map(
                (name, ordinal) => ({
                  documentTypeId: type.id,
                  name,
                  kind: fieldKind(name),
                  required: item.requiredFields.includes(name),
                  ordinal,
                }),
              ),
            });
            if (item.КодыДолжностей.length)
              await tx.documentTypePosition.createMany({
                data: [...new Set(item.КодыДолжностей)].map((code1c) => ({
                  documentTypeId: type.id,
                  code1c,
                })),
              });
          }
          await tx.documentType.updateMany({
            where: {
              erpUid: { notIn: catalog.map((i) => i.УИНДокумента) },
              catalogSyncedAt: { not: null },
            },
            data: { catalogSyncedAt: null },
          });
        },
        { timeout: 30000 },
      );
      this.nextRefresh = Date.now() + 15 * 60_000;
    } catch {
      this.logger.warn(
        "ERP document catalog refresh unavailable; retained previous catalog",
      );
    }
  }
  async list(position: string, citizenship = "ru") {
    await this.ensure();
    const types = await this.prisma.documentType.findMany({
      where: { catalogSyncedAt: { not: null } },
      include: {
        definitions: { orderBy: { ordinal: "asc" } },
        positions: true,
      },
      orderBy: { title: "asc" },
    });
    return {
      items: types
        .filter((t) => applicable(t, position, citizenship))
        .map((t) => ({
          code: t.code,
          title: t.title,
          documentUid: t.erpUid!,
          fields: t.definitions.map((f) => ({
            name: f.name,
            label: FIELD_LABELS[f.name],
            kind: f.kind,
            required: f.required,
            ordinal: f.ordinal,
          })),
        })),
    };
  }
}
