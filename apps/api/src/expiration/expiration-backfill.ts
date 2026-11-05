import type { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { extractExpirationDateFromFields } from "./expiration-dates";

/** Fill missing dates only from the current approved version. */
export class ExpirationBackfill {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async run(options: { apply: boolean; limit: number; after?: string }) {
    const rows = await this.prisma.document.findMany({
      where: { status: "APPROVED", expiresAt: null, ...(options.after ? { id: { gt: options.after } } : {}) },
      orderBy: { id: "asc" },
      take: options.limit + 1,
      select: { id: true },
    });
    const batch = rows.slice(0, options.limit);
    let populated = 0;
    let skipped = 0;
    for (const { id } of batch) {
      const updated = await this.prisma.$transaction(async (tx) => {
        // Review takes this same lock before changing versions or fields.
        await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id} FOR UPDATE`;
        const doc = await tx.document.findUnique({ where: { id }, select: { status: true, expiresAt: true, currentVersion: true } });
        if (!doc || doc.status !== "APPROVED" || doc.expiresAt !== null) return false;
        const version = await tx.documentVersion.findUnique({
          where: { documentId_version: { documentId: id, version: doc.currentVersion } },
          include: { fields: true },
        });
        if (!version || version.status !== "APPROVED") return false;
        const date = extractExpirationDateFromFields(Object.fromEntries(version.fields.map((field) => [field.name, field.value])));
        if (!date || (version.expiresAt && version.expiresAt.getTime() !== date.getTime())) return false;
        if (options.apply) {
          await tx.documentVersion.update({ where: { id: version.id }, data: { expiresAt: date } });
          await tx.document.update({ where: { id }, data: { expiresAt: date } });
          await this.audit.logInTransaction(tx, {
            actorId: "system:expiration-backfill", action: "DATA_IMPORTED", entityType: "Document", entityId: id,
            before: { expiresAt: null }, after: { expiresAt: date.toISOString().slice(0, 10), version: version.version, source: "approved-document-fields" },
          });
        }
        return true;
      });
      if (updated) populated++; else skipped++;
    }
    return { mode: options.apply ? "apply" : "dry-run", scanned: batch.length, populated, skipped, nextAfter: rows.length > options.limit ? batch[batch.length - 1].id : null };
  }
}
