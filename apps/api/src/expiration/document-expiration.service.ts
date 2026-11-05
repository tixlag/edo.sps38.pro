import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import {
  LkNotificationService,
  type SendLkNotificationInput,
} from "../lk/lk-notification.service";
import type { AuthPrincipal } from "../auth/auth-principal";
import { canReviewGroup, candidateReviewGroup, reviewGroupWhere } from "../documents/review-group";
import {
  computeDaysRemaining,
  getExpirationSeverity,
  matchApplicableThreshold,
  extractExpirationDateFromFields,
  expirationScanCutoff,
  type AlertThreshold,
  type ExpirationSeverity,
} from "./expiration-dates";
import { Prisma } from "@prisma/client";

const ALERT_LEASE_MS = 2 * 60 * 1000;
const ALERT_RETRY_BASE_MS = 5 * 60 * 1000;
const ALERT_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const SCAN_BATCH_SIZE = 100;
const RETRY_BATCH_SIZE = 50;

export interface ExpirationsSummaryDto {
  totalExpiring: number;
  warning30d: number;
  urgent15d: number;
  critical7d: number;
  emergency1d: number;
  expired: number;
}

export interface ExpiringItemDto {
  id: string;
  sourceType: "DOCUMENT" | "PREVIOUS_DOCUMENT";
  documentId: string;
  documentTitle: string;
  candidateId: string | null;
  candidateName: string | null;
  candidateCode1c: string | null;
  managerCode1c: string | null;
  managerName: string | null;
  reviewGroup: string | null;
  expiresAt: string;
  daysRemaining: number;
  severity: ExpirationSeverity;
  thresholdDays: AlertThreshold | null;
}

export interface GetExpirationsQueryDto {
  limit?: number;
  offset?: number;
  threshold?: AlertThreshold;
  reviewGroup?: "RU" | "IG" | "ALL";
  managerCode1c?: string;
}

@Injectable()
export class DocumentExpirationService {
  private readonly logger = new Logger(DocumentExpirationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lkNotifications: LkNotificationService,
  ) {}

  /**
   * Background scan running daily via Cron / CLI.
   * Scans approved documents and confirmed previous documents, detects deadline thresholds,
   * deduplicates via document_expiration_alerts, and fires alerts to LK.
   */
  async scanAndDispatchAlerts(now = new Date(), dryRun = false): Promise<{ scanned: number; alertsSent: number }> {
    let scanned = 0;
    let alertsSent = 0;

    // 1. Scan approved active documents
    const cutoff = expirationScanCutoff(now);
    let cursor: string | undefined;
    for (;;) {
    const documents = await this.prisma.document.findMany({
      where: {
        status: "APPROVED",
        expiresAt: { not: null, lte: cutoff },
      },
      orderBy: { id: "asc" }, take: SCAN_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        documentType: true,
        candidate: true,
      },
    });

    for (const doc of documents) {
      if (!doc.expiresAt) continue;
      scanned++;

      const daysRemaining = computeDaysRemaining(doc.expiresAt, now);
      const threshold = matchApplicableThreshold(daysRemaining);
      if (threshold === null) continue; // More than 30 days remaining
      if (!dryRun) await this.supersedeOlderAlerts({ documentId: doc.id }, doc.expiresAt, threshold, now);

      const docTitle = doc.documentType?.title ?? "Документ";
      const candidateName = doc.candidate?.fullName ?? "Кандидат";
      const managerCode1c = doc.candidate?.managerCode1c ?? null;

      // The candidate's manager is the HR recipient for expiration alerts.
      const recipients: Array<{ code1c: string; role: "manager" }> = [];
      if (managerCode1c) {
        recipients.push({ code1c: managerCode1c, role: "manager" });
      }

      for (const recipient of recipients) {
        if (dryRun) continue;
        const formattedDate = doc.expiresAt.toISOString().slice(0, 10);
        const daysText =
          daysRemaining < 0
            ? `**срок истёк** (${formattedDate})`
            : daysRemaining === 0 ? `истекает **сегодня** (${formattedDate})`
            : `истекает через **${daysRemaining} дн.** (${formattedDate})`;

        const content = `У сотрудника **${candidateName}** по документу «${docTitle}» ${daysText}.`;
        const targetUrl = doc.candidateId && doc.candidate
          ? this.candidateUrl(doc.candidateId, candidateReviewGroup(doc.candidate))
          : "/review";

        const sent = await this.dispatchAlert(
          {
            documentId: doc.id,
            previousDocId: null,
            candidateId: doc.candidateId,
            employeeId: doc.employeeId,
            documentTitle: docTitle,
            expiresAt: doc.expiresAt,
            thresholdDays: threshold,
            recipientCode1c: recipient.code1c,
            recipientRole: recipient.role,
          },
          {
            recipientCodes1c: [recipient.code1c],
            title: `Срок документа: ${docTitle}`,
            content,
            type: "toast",
            targetType: "document_expiration",
            targetUrl,
            targetMeta: {
              documentId: doc.id,
              candidateId: doc.candidateId,
              daysRemaining,
              threshold,
            },
          },
          now,
        );
        if (sent) alertsSent++;
      }
    }

    if (documents.length < SCAN_BATCH_SIZE) break;
    cursor = documents[documents.length - 1].id;
    }

    // 2. Scan confirmed previous documents
    cursor = undefined;
    for (;;) {
    const previousDocs: Array<Prisma.CandidatePreviousDocumentGetPayload<{ include: { candidate: true } }>> = await this.prisma.candidatePreviousDocument.findMany({
      where: {
        status: "CONFIRMED",
        expiresAt: { not: null, lte: cutoff },
      },
      orderBy: { id: "asc" }, take: SCAN_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        candidate: true,
      },
    });

    for (const prevDoc of previousDocs) {
      if (!prevDoc.expiresAt) continue;
      scanned++;

      const daysRemaining = computeDaysRemaining(prevDoc.expiresAt, now);
      const threshold = matchApplicableThreshold(daysRemaining);
      if (threshold === null) continue;
      if (!dryRun) await this.supersedeOlderAlerts({ previousDocId: prevDoc.id }, prevDoc.expiresAt, threshold, now);

      const docTitle = prevDoc.title || "Документ";
      const candidateName = prevDoc.candidate?.fullName ?? "Кандидат";
      const managerCode1c = prevDoc.candidate?.managerCode1c ?? null;

      const recipients: Array<{ code1c: string; role: "manager" }> = [];
      if (managerCode1c) recipients.push({ code1c: managerCode1c, role: "manager" });

      for (const recipient of recipients) {
        if (dryRun) continue;
        const formattedDate = prevDoc.expiresAt.toISOString().slice(0, 10);
        const daysText =
          daysRemaining < 0
            ? `**срок истёк** (${formattedDate})`
            : daysRemaining === 0 ? `истекает **сегодня** (${formattedDate})`
            : `истекает через **${daysRemaining} дн.** (${formattedDate})`;
        const content = `У сотрудника **${candidateName}** по историческому документу «${docTitle}» ${daysText}.`;

        const sent = await this.dispatchAlert(
          {
            documentId: null,
            previousDocId: prevDoc.id,
            candidateId: prevDoc.candidateId,
            employeeId: null,
            documentTitle: docTitle,
            expiresAt: prevDoc.expiresAt,
            thresholdDays: threshold,
            recipientCode1c: recipient.code1c,
            recipientRole: recipient.role,
          },
          {
            recipientCodes1c: [recipient.code1c],
            title: `Срок документа: ${docTitle}`,
            content,
            type: "toast",
            targetType: "document_expiration",
            targetUrl: this.candidateUrl(prevDoc.candidateId, candidateReviewGroup(prevDoc.candidate)),
          },
          now,
        );
        if (sent) alertsSent++;
      }
    }

    if (previousDocs.length < SCAN_BATCH_SIZE) break;
    cursor = previousDocs[previousDocs.length - 1].id;
    }

    this.logger.log(`Expiration scan finished: scanned ${scanned} documents, sent ${alertsSent} alerts.`);
    return { scanned, alertsSent };
  }

  /**
   * Claims one alert row before calling LK so concurrent scans do not send the
   * same alert simultaneously. LK uses the alert ID as an idempotency key so a
   * retry after a lost response returns the existing broadcast.
   */
  private async supersedeOlderAlerts(
    source: { documentId: string } | { previousDocId: string },
    expiresAt: Date,
    threshold: AlertThreshold,
    now: Date,
  ): Promise<void> {
    await this.prisma.documentExpirationAlert.updateMany({
      where: {
        ...source, expiresAt, thresholdDays: { gt: threshold },
        OR: [{ status: "RETRY" }, { status: "CLAIMED", leaseExpiresAt: { lte: now } }],
      },
      data: { status: "SUPERSEDED", nextAttemptAt: null, leaseExpiresAt: null, leaseToken: null },
    });
  }

  private async dispatchAlert(
    data: Omit<Prisma.DocumentExpirationAlertUncheckedCreateInput, "id">,
    notification: SendLkNotificationInput,
    now: Date,
  ): Promise<boolean> {
    // Scan timestamps stay fixed for calendar decisions; leases use the actual
    // time, since a long batch may reach a notification minutes later.
    const leaseExpiresAt = new Date(Date.now() + ALERT_LEASE_MS);
    const leaseToken = randomUUID();
    let claim: { id: string; attemptCount: number; payload?: unknown } | null = null;

    try {
      claim = await this.prisma.documentExpirationAlert.create({
        data: {
          ...data,
          status: "CLAIMED",
          attemptCount: 1,
          leaseExpiresAt,
          leaseToken,
          payload: notification as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, attemptCount: true, payload: true },
      });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existing = await this.prisma.documentExpirationAlert.findFirst({
        where: {
          thresholdDays: data.thresholdDays,
          recipientCode1c: data.recipientCode1c,
          expiresAt: data.expiresAt,
          ...(data.documentId
            ? { documentId: data.documentId }
            : { previousDocId: data.previousDocId }),
        },
        select: { id: true, status: true, attemptCount: true, payload: true },
      });
      if (!existing || existing.status === "SENT") return false;

      const reclaimed = await this.prisma.documentExpirationAlert.updateMany({
        where: {
          id: existing.id,
          OR: [
            { status: "RETRY", nextAttemptAt: { lte: now } },
            { status: "CLAIMED", leaseExpiresAt: { lte: now } },
            // Only the daily scan calls this path with the currently applicable
            // date, recipient and threshold. The post-claim source check below
            // confirms they still match, including after A -> B -> A changes.
            { status: "SUPERSEDED" },
          ],
        },
        data: {
          status: "CLAIMED",
          attemptCount: { increment: 1 },
          leaseExpiresAt,
          leaseToken,
          nextAttemptAt: null,
          lastError: null,
          ...(existing.payload == null ? { payload: notification as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      if (reclaimed.count !== 1) return false;
      claim = { id: existing.id, attemptCount: existing.attemptCount + 1, payload: existing.payload ?? notification };
    }

    if (!claim) return false;

    // The scan may have taken minutes; recheck recipient and source after claim.
    const validSource = data.documentId
      ? await this.prisma.document.findFirst({ where: { id: data.documentId, status: "APPROVED", expiresAt: data.expiresAt, candidate: { managerCode1c: data.recipientCode1c } }, select: { id: true } })
      : await this.prisma.candidatePreviousDocument.findFirst({ where: { id: data.previousDocId!, status: "CONFIRMED", expiresAt: data.expiresAt, candidate: { managerCode1c: data.recipientCode1c } }, select: { id: true } });
    if (!validSource) {
      await this.prisma.documentExpirationAlert.updateMany({ where: { id: claim.id, status: "CLAIMED", leaseToken }, data: { status: "SUPERSEDED", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null } });
      return false;
    }

    const payloadToSend = (claim.payload as SendLkNotificationInput | null) ?? notification;
    let result: Awaited<ReturnType<LkNotificationService["sendNotification"]>>;
    try {
      result = await this.lkNotifications.sendNotification({
        ...payloadToSend,
        recipientCodes1c: [data.recipientCode1c],
        idempotencyKey: `document-expiration:${claim.id}`,
      });
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.success) {
      const completed = await this.prisma.documentExpirationAlert.updateMany({
        where: { id: claim.id, status: "CLAIMED", leaseToken },
        data: {
          status: "SENT",
          sentAt: new Date(),
          broadcastUuid: result.broadcastUuid ?? null,
          leaseExpiresAt: null,
          leaseToken: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
      return completed.count === 1;
    }

    const backoffMs = Math.min(
      ALERT_RETRY_BASE_MS * 2 ** Math.min(claim.attemptCount - 1, 16),
      ALERT_RETRY_MAX_MS,
    );
    await this.prisma.documentExpirationAlert.updateMany({
      where: { id: claim.id, status: "CLAIMED", leaseToken },
      data: {
        status: "RETRY",
        leaseExpiresAt: null,
        leaseToken: null,
        nextAttemptAt: new Date(now.getTime() + backoffMs),
        lastError: (result.error ?? "LK rejected notification").slice(0, 2000),
      },
    });
    this.logger.warn(
      `LK notification failed for expiration alert ${claim.id}; retry scheduled after ${backoffMs}ms`,
    );
    return false;
  }

  /** Retry only ledger entries whose delivery is due; never rescan documents. */
  async retryDueAlerts(now = new Date()): Promise<{ processed: number; sent: number }> {
    const due = await this.prisma.documentExpirationAlert.findMany({
      where: { OR: [
        { status: "RETRY", nextAttemptAt: { lte: now } },
        { status: "CLAIMED", leaseExpiresAt: { lte: now } },
      ] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: RETRY_BATCH_SIZE,
      include: {
        document: { include: { candidate: true, documentType: true } },
        previousDoc: { include: { candidate: true } },
      },
    });
    let sent = 0;
    for (const entry of due) {
      const token = randomUUID();
      const claim = await this.prisma.documentExpirationAlert.updateMany({
        where: { id: entry.id, OR: [
          { status: "RETRY", nextAttemptAt: { lte: now } },
          { status: "CLAIMED", leaseExpiresAt: { lte: now } },
        ] },
        data: { status: "CLAIMED", leaseToken: token, leaseExpiresAt: new Date(Date.now() + ALERT_LEASE_MS),
          nextAttemptAt: null, attemptCount: { increment: 1 } },
      });
      if (!claim.count) continue;

      // Refresh the source after acquiring the lease; data in the scan is only a hint.
      const current = await this.prisma.documentExpirationAlert.findUnique({
        where: { id: entry.id },
        include: { document: { include: { candidate: true, documentType: true } }, previousDoc: { include: { candidate: true } } },
      });
      if (!current || current.leaseToken !== token || current.status !== "CLAIMED") continue;
      const source = current.document ?? current.previousDoc;
      const candidate = source?.candidate;
      const currentThreshold = source?.expiresAt ? matchApplicableThreshold(computeDaysRemaining(source.expiresAt, now)) : null;
      const valid = source && candidate && source.expiresAt &&
        (current.document ? current.document.status === "APPROVED" : current.previousDoc?.status === "CONFIRMED") &&
        source.expiresAt.getTime() === current.expiresAt.getTime() &&
        candidate.managerCode1c === current.recipientCode1c && currentThreshold === current.thresholdDays;
      if (!valid) {
        await this.prisma.documentExpirationAlert.updateMany({ where: { id: current.id, status: "CLAIMED", leaseToken: token },
          data: { status: "SUPERSEDED", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null } });
        continue;
      }
      const storedPayload = current.payload as SendLkNotificationInput | null;
      let notificationToSend: SendLkNotificationInput;
      if (storedPayload) {
        notificationToSend = storedPayload;
      } else {
        const days = computeDaysRemaining(source.expiresAt!, now);
        const date = source.expiresAt!.toISOString().slice(0, 10);
        const daysText = days < 0 ? `**срок истёк** (${date})` : days === 0 ? `истекает **сегодня** (${date})` : `истекает через **${days} дн.** (${date})`;
        const title = current.document?.documentType?.title ?? current.previousDoc?.title ?? current.documentTitle;
        notificationToSend = {
          recipientCodes1c: [current.recipientCode1c],
          title: `Срок документа: ${title}`,
          content: `У сотрудника **${candidate.fullName ?? "Кандидат"}** по документу «${title}» ${daysText}.`,
          type: "toast",
          targetType: "document_expiration",
          targetUrl: current.candidateId ? this.candidateUrl(current.candidateId, candidateReviewGroup(candidate)) : "/review",
          targetMeta: { documentId: current.documentId, candidateId: current.candidateId, daysRemaining: days, threshold: current.thresholdDays },
        };
        await this.prisma.documentExpirationAlert.updateMany({
          where: { id: current.id },
          data: { payload: notificationToSend as unknown as Prisma.InputJsonValue },
        });
      }

      let response: Awaited<ReturnType<LkNotificationService["sendNotification"]>>;
      try {
        response = await this.lkNotifications.sendNotification({
          ...notificationToSend,
          recipientCodes1c: [current.recipientCode1c],
          idempotencyKey: `document-expiration:${current.id}`,
        });
      } catch { response = { success: false, error: "LK request failed" }; }
      const backoff = Math.min(ALERT_RETRY_BASE_MS * 2 ** Math.min(current.attemptCount - 1, 16), ALERT_RETRY_MAX_MS);
      const settled = await this.prisma.documentExpirationAlert.updateMany({ where: { id: current.id, status: "CLAIMED", leaseToken: token },
        data: response.success
          ? { status: "SENT", sentAt: new Date(), broadcastUuid: response.broadcastUuid ?? null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, lastError: null }
          : { status: "RETRY", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + backoff), lastError: (response.error ?? "LK rejected notification").slice(0, 2000) },
      });
      if (response.success && settled.count) sent++;
    }
    return { processed: due.length, sent };
  }

  /**
   * Returns KPI summary counts for the Dashboard and Review page tab.
   */
  async getSummary(principal: AuthPrincipal, now = new Date()): Promise<ExpirationsSummaryDto> {
    const permittedGroups = this.permittedReviewGroups(principal);
    if (!permittedGroups.length) {
      return { totalExpiring: 0, warning30d: 0, urgent15d: 0, critical7d: 0, emergency1d: 0, expired: 0 };
    }

    const where: Prisma.DocumentWhereInput = {
      status: "APPROVED",
      expiresAt: { not: null },
      ...this.documentGroupWhere(permittedGroups),
    };

    const counts = await Promise.all(([30, 15, 7, 1, 0] as const).map(async (threshold) => {
      const expiresAt = this.dateRange(now, threshold);
      const [docs, previous] = await Promise.all([
        this.prisma.document.count({ where: { ...where, expiresAt } }),
        this.prisma.candidatePreviousDocument.count({ where: { status: "CONFIRMED", expiresAt, candidate: this.candidateGroupWhere(permittedGroups) } }),
      ]);
      return docs + previous;
    }));
    const [warning30d, urgent15d, critical7d, emergency1d, expired] = counts;
    const totalExpiring = counts.reduce((a, b) => a + b, 0);
    return { totalExpiring, warning30d, urgent15d, critical7d, emergency1d, expired };
  }

  private dateRange(now: Date, threshold?: AlertThreshold): Prisma.DateTimeNullableFilter {
    const today = expirationScanCutoff(now).getTime() - 30 * 86_400_000;
    const at = (days: number) => new Date(today + days * 86_400_000);
    if (threshold === 0) return { lte: at(0) };
    if (threshold === 1) return { gte: at(1), lte: at(1) };
    if (threshold === 7) return { gte: at(2), lte: at(7) };
    if (threshold === 15) return { gte: at(8), lte: at(15) };
    if (threshold === 30) return { gte: at(16), lte: at(30) };
    return { lte: at(30) };
  }

  /**
   * Returns paginated list of expiring documents with candidate details.
   */
  async getItems(
    principal: AuthPrincipal,
    query: GetExpirationsQueryDto = {},
    now = new Date(),
  ): Promise<{ items: ExpiringItemDto[]; total: number }> {
    const permittedGroups = this.permittedReviewGroups(principal);
    if (!permittedGroups.length) {
      return { items: [], total: 0 };
    }

    if (query.reviewGroup && query.reviewGroup !== "ALL" && !permittedGroups.includes(query.reviewGroup)) {
      return { items: [], total: 0 };
    }
    const effectiveGroups = query.reviewGroup && query.reviewGroup !== "ALL"
      ? [query.reviewGroup] : permittedGroups;

    const expiresAt = this.dateRange(now, query.threshold);
    const docWhere: Prisma.DocumentWhereInput = {
      status: "APPROVED", expiresAt, ...this.documentGroupWhere(effectiveGroups),
      ...(query.managerCode1c ? { candidate: { managerCode1c: query.managerCode1c } } : {}),
    };
    const prevWhere: Prisma.CandidatePreviousDocumentWhereInput = {
      status: "CONFIRMED", expiresAt,
      candidate: { ...this.candidateGroupWhere(effectiveGroups),
        ...(query.managerCode1c ? { managerCode1c: query.managerCode1c } : {}) },
    };
    const [docTotal, prevTotal] = await Promise.all([
      this.prisma.document.count({ where: docWhere }),
      this.prisma.candidatePreviousDocument.count({ where: prevWhere }),
    ]);
    // Bounded ordered streams keep memory independent of page offset.
    type D = Prisma.DocumentGetPayload<{ include: { documentType: true; candidate: true } }>;
    type P = Prisma.CandidatePreviousDocumentGetPayload<{ include: { candidate: true } }>;
    let docs: D[] = [], prevs: P[] = [];
    let di = 0, pi = 0, dSkip = 0, pSkip = 0, dDone = false, pDone = false;
    const limit = query.limit ?? 50, offset = query.offset ?? 0;
    const items: ExpiringItemDto[] = [];
    let seen = 0;
    while (seen < offset + limit) {
      if (di >= docs.length && !dDone) {
        docs = await this.prisma.document.findMany({ where: docWhere, include: { documentType: true, candidate: true },
          orderBy: [{ expiresAt: "asc" }, { id: "asc" }], skip: dSkip, take: 100 });
        dSkip += docs.length; di = 0; dDone = docs.length < 100;
      }
      if (pi >= prevs.length && !pDone) {
        prevs = await this.prisma.candidatePreviousDocument.findMany({ where: prevWhere, include: { candidate: true },
          orderBy: [{ expiresAt: "asc" }, { id: "asc" }], skip: pSkip, take: 100 });
        pSkip += prevs.length; pi = 0; pDone = prevs.length < 100;
      }
      const doc = docs[di], prev = prevs[pi];
      if (!doc && !prev) break;
      const isDoc = !!doc && (!prev || doc.expiresAt!.getTime() <= prev.expiresAt!.getTime());
      const row = isDoc ? doc : prev;
      if (isDoc) di++; else pi++;
      if (seen++ < offset) continue;
      const candidate = row.candidate;
      const days = computeDaysRemaining(row.expiresAt!, now);
      items.push({
        id: (isDoc ? "doc-" : "prev-") + row.id, sourceType: isDoc ? "DOCUMENT" : "PREVIOUS_DOCUMENT",
        documentId: row.id, documentTitle: isDoc ? (doc.documentType?.title ?? "Документ") : (prev.title || "Документ"),
        candidateId: row.candidateId, candidateName: candidate?.fullName ?? null, candidateCode1c: candidate?.code1c ?? null,
        managerCode1c: candidate?.managerCode1c ?? null, managerName: candidate?.managerName ?? null,
        reviewGroup: candidate ? candidateReviewGroup(candidate) : "RU",
        expiresAt: row.expiresAt!.toISOString().slice(0, 10), daysRemaining: days,
        severity: getExpirationSeverity(days), thresholdDays: matchApplicableThreshold(days),
      });
    }
    return { items, total: docTotal + prevTotal };
  }

  /**
   * Helper called during document review or field editing to synchronize expiresAt
   * onto DocumentVersion and Document.
   */
  async syncDocumentExpiresAt(
    tx: Prisma.TransactionClient,
    documentId: string,
    versionId: string,
    fields: Record<string, unknown>,
  ): Promise<Date | null> {
    const expiresAt = extractExpirationDateFromFields(fields);

    await tx.documentVersion.update({
      where: { id: versionId },
      data: { expiresAt },
    });

    const doc = await tx.document.findUnique({
      where: { id: documentId },
      select: { expiresAt: true },
    });

    // If expiration date changed on Document, reset past alerts so new thresholds fire properly
    if (doc?.expiresAt?.toISOString() !== expiresAt?.toISOString()) {
      await tx.document.update({
        where: { id: documentId },
        data: { expiresAt },
      });

      await tx.documentExpirationAlert.deleteMany({
        where: { documentId },
      });
    }

    return expiresAt;
  }

  private permittedReviewGroups(principal: AuthPrincipal): Array<"RU" | "IG"> {
    const groups: Array<"RU" | "IG"> = [];
    if (canReviewGroup(principal, "RU")) groups.push("RU");
    if (canReviewGroup(principal, "IG")) groups.push("IG");
    return groups;
  }

  private candidateGroupWhere(groups: Array<"RU" | "IG">): Prisma.CandidateWhereInput {
    return groups.length === 2 ? {} : reviewGroupWhere(groups[0]);
  }

  private documentGroupWhere(groups: Array<"RU" | "IG">): Prisma.DocumentWhereInput {
    return groups.length === 2 ? {} : {
      OR: [
        { candidate: this.candidateGroupWhere(groups) },
        ...(groups[0] === "RU" ? [{ candidateId: null }] : []),
      ],
    };
  }

  private candidateUrl(id: string, group: "RU" | "IG"): string {
    const encoded = encodeURIComponent(id);
    return group === "IG" ? `/review-ig?candidate=${encoded}` : `/review/candidates/${encoded}`;
  }
}
