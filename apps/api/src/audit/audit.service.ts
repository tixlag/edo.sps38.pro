import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEvent {
  actorId?: string;
  action:
    | 'EMPLOYEE_CREATED'
    | 'DOCUMENT_UPLOADED'
    | 'DOCUMENT_RETURNED'
    | 'DOCUMENT_APPROVED'
    | 'DOCUMENT_SIGNED'
    | 'WORKFLOW_STAGE_CHANGED'
    | 'DATA_IMPORTED'
    | 'LK_REFERENCE_SYNCED'
    | 'LK_EVENT_APPLIED';
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
}

type PrismaTx = Omit<PrismaService, '$connect' | '$disconnect' | '$transaction' | '$queryRaw'> & {
  auditLog: PrismaService['auditLog'];
};

/**
 * Audit is core: critical domain mutations must write state + audit atomically
 * via `logInTransaction(tx, event)` inside a single Prisma `$transaction`.
 * `log()` outside a transaction propagates DB errors (no silent swallowing).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  async log(event: AuditEvent): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: (event.before ?? null) as never,
        after: (event.after ?? null) as never,
        correlationId: event.correlationId ?? null,
      },
    });
  }

  async logInTransaction(tx: PrismaTx, event: AuditEvent): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: (event.before ?? null) as never,
        after: (event.after ?? null) as never,
        correlationId: event.correlationId ?? null,
      },
    });
  }
}
