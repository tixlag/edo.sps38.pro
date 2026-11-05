import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { LkNotificationService } from "../lk/lk-notification.service";

/** The notification row is written in the same transaction as the contract action. */
@Injectable()
export class ContractNotificationDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractNotificationDeliveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private immediate?: ReturnType<typeof setImmediate>;
  private running = false;
  private stopped = false;
  private recoveryRequested = false;
  private readonly pendingContracts = new Set<string>();

  constructor(private readonly prisma: PrismaService, private readonly lk: LkNotificationService, private readonly config: ConfigService) {}

  onModuleInit() {
    if (this.config.get<string>("CONTRACT_NOTIFICATION_WORKER_ENABLED") !== "true") return;
    // Immediate recovery on startup and periodic repair if a process dies
    // after the database commit but before the in-process wake-up.
    this.wake();
    this.timer = setInterval(() => this.wake(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
  }

  /** Called only after commit; the database remains authoritative on a lost wake-up. */
  wake(contractId?: string): void {
    if (this.stopped || this.config.get<string>("CONTRACT_NOTIFICATION_WORKER_ENABLED") !== "true") return;
    if (contractId) {
      // Bound in-memory hints; a recovery pass covers any discarded hints.
      if (this.pendingContracts.size < 10_000) this.pendingContracts.add(contractId);
      else this.recoveryRequested = true;
    } else {
      this.recoveryRequested = true;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.running || this.immediate) return;
    this.immediate = setImmediate(() => {
      this.immediate = undefined;
      void this.tick();
    });
    this.immediate.unref();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const targets = Array.from(this.pendingContracts).slice(0, 50);
      for (const id of targets) this.pendingContracts.delete(id);
      if (targets.length === 0) this.recoveryRequested = false;
      const pending = await this.prisma.signingContractNotification.findMany({
        where: {
          deliveryCancelledAt: null,
          ...(targets.length ? { contractId: { in: targets } } : {}),
          AND: [
            { OR: [
              { deliveredAt: null, OR: [{ readAt: null }, { deliveryAttempts: { gt: 0 } }] },
              { kind: { not: "sent" }, deliveredAt: { not: null }, readAt: { not: null }, lkReadSyncedAt: null, lkBroadcastUuid: { not: null } },
            ] },
            { OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }] },
            { OR: [{ deliveryRetryAt: null }, { deliveryRetryAt: { lte: now } }] },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: 50,
      });
      let claimedCount = 0;
      for (const row of pending) {
        const token = randomUUID();
        const claimed = await this.prisma.signingContractNotification.updateMany({
          where: {
            id: row.id,
            deliveryCancelledAt: null,
            AND: [
              { OR: [
                { deliveredAt: null, OR: [{ readAt: null }, { deliveryAttempts: { gt: 0 } }] },
                { kind: { not: "sent" }, deliveredAt: { not: null }, readAt: { not: null }, lkReadSyncedAt: null, lkBroadcastUuid: { not: null } },
              ] },
              { OR: [{ deliveryLeaseUntil: null }, { deliveryLeaseUntil: { lte: now } }] },
              { OR: [{ deliveryRetryAt: null }, { deliveryRetryAt: { lte: now } }] },
            ],
          },
          data: {
            deliveryLeaseToken: token,
            deliveryLeaseUntil: new Date(Date.now() + 120_000),
            deliveryAttempts: { increment: 1 },
          },
        });
        if (!claimed.count) continue;
        claimedCount++;

        let deliveredUuid: string | null = null;
        let readSynced = false;
        try {
          const current = await this.prisma.signingContractNotification.findUnique({
            where: { id: row.id },
            include: { contract: { select: { status: true } } },
          });
          if (!current) continue;
          // Invitations that have not entered LK must not be retried after the
          // employee has already completed or declined the contract. A send
          // already in flight can race with that transition, so its wording is
          // deliberately neutral and the link always opens the current state.
          if (current.kind === "sent" && !current.deliveredAt && current.contract.status !== "WAITING_EMPLOYEE") {
            await this.prisma.signingContractNotification.updateMany({
              where: { id: row.id, deliveryLeaseToken: token, deliveredAt: null },
              data: { deliveryCancelledAt: new Date(), deliveryLeaseToken: null, deliveryLeaseUntil: null, deliveryRetryAt: null },
            });
            continue;
          }
          if (current.kind !== "sent" && current.deliveredAt && current.readAt && current.lkBroadcastUuid) {
            await this.lk.markRead(current.recipientId, { uuids: [current.lkBroadcastUuid] });
            readSynced = true;
          } else if (!current.deliveredAt) {
          // For an employee invitation the frozen recipientId is code1c. Existing
          // completion and refusal notices use the sender's UUID instead.
          const isInvitation = current.kind === "sent";
          const employees = isInvitation ? [] : await this.prisma.lkEmployee.findMany({
            where: { uuid: current.recipientId },
            select: { code1c: true },
            take: 2,
          });
          const recipientCode = isInvitation
            ? current.recipientId.trim()
            : employees.length === 1 ? employees[0].code1c : null;
          if (recipientCode) {
            const result = await this.lk.sendNotification({
              recipientCodes1c: [recipientCode],
              title: isInvitation ? "Вам направлен договор" : "Подписание договора",
              content: current.message,
              type: "toast",
              targetType: "signing_contract",
              targetUrl: `/${isInvitation ? "my-documents" : "signing"}?contractId=${encodeURIComponent(current.contractId)}`,
              idempotencyKey: `signing-contract-notification:${row.id}`,
            });
            if (result.success && result.broadcastUuid) deliveredUuid = result.broadcastUuid;
          }
          }
        } catch {
          this.logger.warn("Contract notification delivery failed; will retry");
        }

        const delay = Math.min(300_000 * 2 ** Math.min(row.deliveryAttempts, 8), 86_400_000);
        await this.prisma.signingContractNotification.updateMany({
          where: { id: row.id, deliveryLeaseToken: token },
          data: {
            ...(deliveredUuid ? { deliveredAt: new Date(), lkBroadcastUuid: deliveredUuid } : {}),
            ...(readSynced ? { lkReadSyncedAt: new Date() } : {}),
            deliveryRetryAt: deliveredUuid || readSynced ? null : new Date(Date.now() + delay),
            deliveryLeaseToken: null,
            deliveryLeaseUntil: null,
          },
        });
        // A new contract committed during a long recovery pass should not
        // wait for every older notification in that pass.
        if (this.pendingContracts.size) {
          // Remaining rows from this already-fetched batch have not been
          // claimed. Revisit them in a recovery pass after urgent hints.
          this.recoveryRequested = true;
          break;
        }
      }
      if (pending.length === 50 && claimedCount > 0) this.recoveryRequested = true;
    } catch {
      this.logger.warn("Contract notification delivery unavailable; will retry");
    } finally {
      this.running = false;
      if (this.pendingContracts.size || this.recoveryRequested) this.schedule();
    }
  }
}
