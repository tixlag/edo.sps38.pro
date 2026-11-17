import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { LkNotificationService } from "../lk/lk-notification.service";

export interface ConfirmedEmploymentCard {
  fullName: string;
  employmentConfirmed: boolean;
  employmentConfirmationId?: string | null;
  employmentNotificationRecipientCodes1c: string[];
}

/** ERP proves both the hire and recipients; LK owns delivery idempotency. */
@Injectable()
export class EmploymentNotificationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EmploymentNotificationService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lk: LkNotificationService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (
      this.config.get("DOCUMENT_WORKER_ENABLED") === "false" ||
      this.config.get("NODE_ENV") === "test"
    )
      return;
    const tick = () => {
      void this.retry().catch(() =>
        this.logger.warn("Employment notification retry failed"),
      );
    };
    tick();
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }

  async observe(
    candidateId: string,
    card: ConfirmedEmploymentCard,
  ): Promise<boolean> {
    if (!card.employmentConfirmed) return false;
    const confirmationKey = card.employmentConfirmationId?.trim().toLowerCase();
    // A stable HR event identity is required to distinguish a later rehire.
    if (!confirmationKey || confirmationKey.length > 128) return false;
    const recipients = [
      ...new Set(
        card.employmentNotificationRecipientCodes1c
          .map((code) => code.trim())
          .filter(Boolean),
      ),
    ].sort();
    if (!recipients.length) return false;
    if (recipients.length > 100 || recipients.some((code) => code.length > 64))
      return false;
    let operation;
    try {
      operation = await this.prisma.candidateEmploymentNotification.upsert({
        where: {
          candidateId_confirmationKey: { candidateId, confirmationKey },
        },
        create: {
          candidateId,
          confirmationKey,
          recipientCodes1c: recipients,
          title: "Кандидат трудоустроен",
          content: `Трудоустройство кандидата **${card.fullName.trim() || "Кандидат"}** подтверждено в ERP.`,
          targetUrl: `/review/candidates/${encodeURIComponent(candidateId)}`,
        },
        update: {},
      });
    } catch (error) {
      // An emulated upsert may race between a refresh and another API instance.
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      )
        throw error;
      operation =
        await this.prisma.candidateEmploymentNotification.findUniqueOrThrow({
          where: {
            candidateId_confirmationKey: { candidateId, confirmationKey },
          },
        });
    }
    if (operation.status !== "SENT") await this.deliver(operation.id);
    return true;
  }

  retry(): Promise<void> {
    if (!this.running)
      this.running = this.retryPending().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async retryPending() {
    if (this.stopped) return;
    const now = new Date();
    const pending = await this.prisma.candidateEmploymentNotification.findMany({
      where: {
        nextAttemptAt: { lte: now },
        OR: [
          { status: "PENDING" },
          { status: "FAILED" },
          { status: "SENDING", leaseUntil: { lte: now } },
        ],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: 20,
    });
    for (const operation of pending) {
      if (this.stopped) return;
      await this.deliver(operation.id);
    }
  }
  private async deliver(id: string) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000);
    const claimed =
      await this.prisma.candidateEmploymentNotification.updateMany({
        where: {
          id,
          nextAttemptAt: { lte: now },
          OR: [
            { status: "PENDING" },
            { status: "FAILED" },
            { status: "SENDING", leaseUntil: { lte: now } },
          ],
        },
        data: { status: "SENDING", leaseUntil, attempts: { increment: 1 } },
      });
    if (claimed.count !== 1) return;
    const operation =
      await this.prisma.candidateEmploymentNotification.findUniqueOrThrow({
        where: { id },
      });
    let success = false;
    try {
      const recipients = operation.recipientCodes1c;
      if (
        Array.isArray(recipients) &&
        recipients.length &&
        recipients.every(
          (code) => typeof code === "string" && code.trim().length > 0,
        )
      ) {
        const result = await this.lk.sendNotification({
          recipientCodes1c: recipients as string[],
          title: operation.title,
          content: operation.content,
          targetType: "candidate_employment_confirmed",
          targetUrl: operation.targetUrl,
          idempotencyKey: `employment-confirmed:${id}`,
          type: "toast",
        });
        success =
          result.success &&
          result.complete !== false &&
          result.outcome !== "partial" &&
          result.outcome !== "none";
      }
    } catch {
      // Keep the durable operation and the same LK idempotency key after an uncertain result.
      this.logger.warn(`Employment notification ${id} could not be delivered`);
    }
    await this.prisma.candidateEmploymentNotification.updateMany({
      where: { id, status: "SENDING", leaseUntil },
      data: {
        status: success ? "SENT" : "FAILED",
        leaseUntil: null,
        sentAt: success ? new Date() : null,
        lastError: success ? null : "LK_NOTIFICATION_NOT_CONFIRMED",
        nextAttemptAt: new Date(
          Date.now() +
            Math.min(60_000 * 2 ** Math.min(operation.attempts, 6), 3_600_000),
        ),
      },
    });
  }
}
