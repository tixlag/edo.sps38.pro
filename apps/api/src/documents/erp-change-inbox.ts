import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma, type ErpChangeInbox } from "@prisma/client";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service";

export const ERP_CHANGE_TARGETS = ["CANDIDATE", "PERSON"] as const;
export const ERP_CHANGE_CATEGORIES = [
  "PROFILE",
  "DOCUMENTS",
  "ARRIVALS",
] as const;
export type ErpChangeCategory = (typeof ERP_CHANGE_CATEGORIES)[number];
export type ErpChangeTarget = (typeof ERP_CHANGE_TARGETS)[number];

export const erpChangesSchema = z
  .object({
    version: z.literal(1),
    items: z
      .array(
        z
          .object({
            eventId: z
              .string()
              .uuid()
              .transform((id) => id.toLowerCase()),
            target: z.enum(ERP_CHANGE_TARGETS),
            uid: z
              .string()
              .uuid()
              .transform((uid) => uid.toLowerCase()),
            changes: z.array(z.enum(ERP_CHANGE_CATEGORIES)).min(1).max(3),
          })
          .strict()
          .refine(
            (item) =>
              item.target === "PERSON" || !item.changes.includes("ARRIVALS"),
          ),
      )
      .min(1)
      .max(50),
  })
  .strict();

type ChangeItem = z.infer<typeof erpChangesSchema>["items"][number];
type ChangeGroup = {
  target: ErpChangeTarget;
  uid: string;
  changes: Set<ErpChangeCategory>;
  eventKey: string;
};

export function groupErpChanges(items: ChangeItem[]): ChangeGroup[] {
  const grouped = new Map<
    string,
    Omit<ChangeGroup, "eventKey"> & { ids: Set<string> }
  >();
  for (const item of items) {
    const key = `${item.target}:${item.uid}`;
    const group = grouped.get(key) ?? {
      target: item.target,
      uid: item.uid,
      changes: new Set<ErpChangeCategory>(),
      ids: new Set<string>(),
    };
    for (const change of item.changes) group.changes.add(change);
    group.ids.add(item.eventId);
    grouped.set(key, group);
  }
  return Array.from(grouped.values(), ({ ids, ...group }) => ({
    ...group,
    eventKey: createHash("sha256")
      .update([...ids].sort().join(":"))
      .digest("hex"),
  }));
}

const fields = {
  PROFILE: "profileRevision",
  DOCUMENTS: "documentsRevision",
  ARRIVALS: "arrivalsRevision",
} as const;

const categoryBits = { PROFILE: 1, DOCUMENTS: 2, ARRIVALS: 4 } as const;
export function pendingCategories(row: ErpChangeInbox): ErpChangeCategory[] {
  return ERP_CHANGE_CATEGORIES.filter((category) => row[fields[category]] > 0n);
}
export function settleCategory(
  current: bigint,
  claimed: bigint,
  applied: boolean,
) {
  return applied && current === claimed ? 0n : current;
}

@Injectable()
export class ErpChangeInboxService {
  constructor(private readonly prisma: PrismaService) {}

  async accept(items: ChangeItem[]): Promise<void> {
    const groups = groupErpChanges(items).sort(
      (a, b) => a.target.localeCompare(b.target) || a.uid.localeCompare(b.uid),
    );
    const rows = groups.map(
      ({ target, uid, changes, eventKey }) =>
        Prisma.sql`(${target}, ${uid}, ${eventKey}, 1,
        ${Number(changes.has("PROFILE"))}, ${Number(changes.has("DOCUMENTS"))},
        ${Number(changes.has("ARRIVALS"))}, UTC_TIMESTAMP(3))`,
    );
    await this.prisma.$executeRaw`
      INSERT INTO erp_change_inbox
        (target, uid, lastEventKey, revision, profileRevision, documentsRevision, arrivalsRevision, dueAt)
      VALUES ${Prisma.join(rows)}
      ON DUPLICATE KEY UPDATE
        profileRevision = IF(lastEventKey <> VALUES(lastEventKey) AND VALUES(profileRevision) > 0, revision + 1, profileRevision),
        documentsRevision = IF(lastEventKey <> VALUES(lastEventKey) AND VALUES(documentsRevision) > 0, revision + 1, documentsRevision),
        arrivalsRevision = IF(lastEventKey <> VALUES(lastEventKey) AND VALUES(arrivalsRevision) > 0, revision + 1, arrivalsRevision),
        dueAt = IF(lastEventKey <> VALUES(lastEventKey), UTC_TIMESTAMP(3), dueAt),
        revision = revision + (lastEventKey <> VALUES(lastEventKey)),
        lastEventKey = VALUES(lastEventKey)
    `;
  }

  due(tx: Prisma.TransactionClient = this.prisma) {
    return tx.erpChangeInbox.findMany({
      where: { dueAt: { lte: new Date() } },
      orderBy: [{ dueAt: "asc" }, { target: "asc" }, { uid: "asc" }],
      take: 50,
    });
  }

  async settle(
    snapshot: ErpChangeInbox,
    result: {
      applied: Set<ErpChangeCategory>;
      deferred: Set<ErpChangeCategory>;
      candidateId?: string;
      retryWidth?: number;
    },
    assertLease: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const { target, uid } = snapshot;
    await this.prisma.$transaction(async (tx) => {
      await assertLease(tx);
      await tx.$queryRaw`SELECT uid FROM erp_change_inbox WHERE target = ${target} AND uid = ${uid} FOR UPDATE`;
      const where = { target_uid: { target, uid } };
      const current = await tx.erpChangeInbox.findUniqueOrThrow({ where });
      const seen = (kind: ErpChangeCategory) => snapshot[fields[kind]] > 0n;
      const defer = (kind: ErpChangeCategory) =>
        seen(kind) && result.deferred.has(kind);
      const applied = (kind: ErpChangeCategory) =>
        seen(kind) && result.applied.has(kind);
      const revisions = {
        profileRevision: settleCategory(
          current.profileRevision,
          snapshot.profileRevision,
          applied("PROFILE") || defer("PROFILE"),
        ),
        documentsRevision: settleCategory(
          current.documentsRevision,
          snapshot.documentsRevision,
          applied("DOCUMENTS") || defer("DOCUMENTS"),
        ),
        arrivalsRevision: settleCategory(
          current.arrivalsRevision,
          snapshot.arrivalsRevision,
          applied("ARRIVALS"),
        ),
      };
      const remaining = Object.values(revisions).some(
        (revision) => revision > 0n,
      );
      const newer = current.revision !== snapshot.revision;
      const attempts = remaining && !newer ? current.attempts + 1 : 0;
      const deferredMask = ERP_CHANGE_CATEGORIES.reduce((mask, kind) => {
        if (defer(kind)) return mask | categoryBits[kind];
        if (applied(kind)) return mask & ~categoryBits[kind];
        return mask;
      }, current.deferredMask);
      const notify = ERP_CHANGE_CATEGORIES.some(applied);
      await tx.erpChangeInbox.update({
        where,
        data: {
          ...revisions,
          attempts,
          deferredMask,
          batchWidth: remaining
            ? (result.retryWidth ?? current.batchWidth)
            : 50,
          dueAt: remaining
            ? new Date(
                Date.now() +
                  (newer
                    ? 0
                    : Math.min(
                        30_000 * 2 ** Math.min(attempts - 1, 6),
                        600_000,
                      )),
              )
            : null,
          ...(notify
            ? {
                notifyRevision: { increment: 1 },
                notifyCandidateId: result.candidateId ?? null,
                notifyAt: new Date(),
              }
            : {}),
        },
      });
    });
  }

  async resumeLinkedPeople(): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE erp_change_inbox AS i
      JOIN ig_arrival_persons AS p ON p.personUid = i.uid
      SET i.profileRevision = IF(i.deferredMask & 1, i.revision + 1, i.profileRevision),
          i.documentsRevision = IF(i.deferredMask & 2, i.revision + 1, i.documentsRevision),
          i.revision = i.revision + 1,
          i.deferredMask = 0,
          i.attempts = 0,
          i.dueAt = UTC_TIMESTAMP(3)
      WHERE i.target = 'PERSON' AND i.deferredMask > 0
        AND p.candidateId IS NOT NULL AND p.igVerified = 1 AND p.bindingError IS NULL
    `;
  }

  notifications() {
    return this.prisma.erpChangeInbox.findMany({
      where: { notifyAt: { lte: new Date() } },
      orderBy: { notifyAt: "asc" },
      take: 50,
    });
  }

  async acknowledgeNotifications(rows: ErpChangeInbox[]): Promise<void> {
    await this.prisma.erpChangeInbox.updateMany({
      where: {
        OR: rows.map(({ target, uid, notifyRevision }) => ({
          target,
          uid,
          notifyRevision,
        })),
      },
      data: { notifyAt: null, notifyCandidateId: null },
    });
  }
}
