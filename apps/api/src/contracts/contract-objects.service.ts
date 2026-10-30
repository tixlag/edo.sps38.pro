import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import type { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";

/** Staging ledger closes the S3/DB crash gap. Only a domain transaction may retain an object. */
@Injectable()
export class ContractObjectsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(ContractObjectsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => void this.cleanup(), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async stage(contractId: string, name: string, bytes: Buffer, mime: string) {
    const key = `contracts/${contractId}/${randomUUID()}/${name}`;
    await this.prisma.signingContractObject.create({ data: { key } });
    await this.storage.uploadBuffer(key, bytes, mime);
    return key;
  }
  async retain(tx: Prisma.TransactionClient, keys: string[]) {
    const updated = await tx.signingContractObject.updateMany({
      where: { key: { in: keys }, retained: false, cleanupClaimed: false },
      data: { retained: true },
    });
    if (updated.count !== keys.length)
      throw new ConflictException(
        "Срок сохранения файла истёк. Повторите загрузку.",
      );
  }
  async cleanup() {
    if (this.running) return;
    this.running = true;
    try {
      const abandoned = await this.prisma.signingContract.findMany({
        where: {
          status: "PREPARING",
          updatedAt: { lt: new Date(Date.now() - 600_000) },
        },
        take: 20,
      });
      for (const row of abandoned)
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.signingContract.updateMany({
            where: { id: row.id, status: "PREPARING", revision: row.revision },
            data: {
              status: "FAILED",
              errorMessage:
                "Формирование прервано. Загрузите готовый договор или создайте новый.",
              revision: { increment: 1 },
            },
          });
          if (changed.count)
            await this.audit.logInTransaction(tx, {
              action: "CONTRACT_PREPARATION_FAILED",
              entityType: "SigningContract",
              entityId: row.id,
              before: { status: "PREPARING" },
              after: { status: "FAILED", reason: "abandoned" },
            });
        });
      // All external calls are bounded to <5min; a one-hour grace also covers an interrupted request.
      const pending = await this.prisma.signingContractObject.findMany({
        where: {
          retained: false,
          createdAt: { lt: new Date(Date.now() - 3_600_000) },
        },
        take: 50,
      });
      for (const object of pending) {
        const claimed = await this.prisma.signingContractObject.updateMany({
          where: { key: object.key, retained: false },
          data: { cleanupClaimed: true },
        });
        if (!claimed.count) continue;
        await this.storage.delete(object.key);
        await this.prisma.signingContractObject.deleteMany({
          where: { key: object.key, retained: false, cleanupClaimed: true },
        });
      }
    } catch {
      this.logger.warn("Contract staged-object cleanup failed; will retry");
    } finally {
      this.running = false;
    }
  }
}
