import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RedisService } from "../redis/redis.module";
import { PrismaService } from "../prisma/prisma.service";
import {
  applicable,
  erpCatalogSchema,
  FIELD_LABELS,
  fieldKind,
} from "./document-contract";
import { erpDocumentHeaders } from "./erp-document-auth";

const CATALOG_TTL_MS = 24 * 60 * 60_000;
const RETRY_MS = 90_000;
const REFRESH_LOCK_KEY = "edo:document-catalog:refresh";
type RefreshResult = "done" | "busy";

const LEGACY_CODES: Record<string, string> = {
  "6ffb1fd5-8341-11eb-ba8b-00259002db81": "PASSPORT",
  "f97a4962-8c32-11eb-ba8b-00259002db81": "SNILS",
  "2452c57b-8c32-11eb-ba8b-00259002db81": "INN",
  "6d5f0835-8c54-11eb-ba8b-00259002db81": "MILITARY",
  "5a339bce-4386-11ec-80c9-002590854e7f": "BANK_DETAILS",
};
@Injectable()
export class DocumentCatalogService {
  private refreshPromise?: Promise<RefreshResult>;
  private nextRefresh = 0;
  private readonly logger = new Logger(DocumentCatalogService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}
  private async lastSyncedAt(): Promise<Date | null> {
    const snapshot = await this.prisma.documentType.findFirst({
      where: { catalogSyncedAt: { not: null } },
      orderBy: { catalogSyncedAt: "desc" },
      select: { catalogSyncedAt: true },
    });
    return snapshot?.catalogSyncedAt ?? null;
  }
  private isFresh(syncedAt: Date | null): boolean {
    return (
      syncedAt !== null && Date.now() < syncedAt.getTime() + CATALOG_TTL_MS
    );
  }
  async ensure(): Promise<void> {
    const snapshot = await this.lastSyncedAt();
    if (this.isFresh(snapshot)) return;
    if (!this.refreshPromise && Date.now() >= this.nextRefresh) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    // An existing snapshot is immediately usable while one process refreshes it.
    if (snapshot) return;
    if ((await this.refreshPromise) === "busy") {
      // Only the initial bootstrap waits for a snapshot being fetched by a peer.
      const deadline = Date.now() + 50_000;
      while (Date.now() < deadline) {
        if (await this.lastSyncedAt()) return;
        try {
          if (!(await this.redis.getStrict(REFRESH_LOCK_KEY))) break;
        } catch {
          break;
        }
        await delay(250);
      }
    }
    if (!(await this.lastSyncedAt()))
      throw new ServiceUnavailableException("ERP_DOCUMENT_CATALOG_UNAVAILABLE");
  }
  private async refresh(): Promise<RefreshResult> {
    this.nextRefresh = Date.now() + RETRY_MS;
    const token = this.config.get<string>("ERP_DOCUMENTS_TOKEN");
    if (!token) return "done";
    const owner = randomUUID();
    try {
      // No refresh without coordination; cached reads remain available if Redis is down.
      if (!(await this.redis.setNxPxStrict(REFRESH_LOCK_KEY, owner, RETRY_MS)))
        return "busy";
      // A peer may have completed the snapshot since ensure() read it.
      if (this.isFresh(await this.lastSyncedAt())) {
        await this.redis.compareAndDelStrict(REFRESH_LOCK_KEY, owner);
        return "done";
      }
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
          if ((await this.redis.getStrict(REFRESH_LOCK_KEY)) !== owner)
            throw new Error("ERP_CATALOG_REFRESH_LOCK_LOST");
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
          // A lost lease aborts the transaction instead of overwriting a newer snapshot.
          if ((await this.redis.getStrict(REFRESH_LOCK_KEY)) !== owner)
            throw new Error("ERP_CATALOG_REFRESH_LOCK_LOST");
        },
        { timeout: 30000 },
      );
      this.nextRefresh = 0;
      await this.redis.compareAndDelStrict(REFRESH_LOCK_KEY, owner);
    } catch {
      // On failure keep the expiring lease as a shared retry cooldown (also across restarts).
      this.logger.warn(
        "ERP document catalog refresh unavailable; retained previous catalog",
      );
    }
    return "done";
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
