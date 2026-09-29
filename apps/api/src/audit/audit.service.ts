import { Injectable } from '@nestjs/common';
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
    | 'DATA_IMPORTED';
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  correlationId?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(event: AuditEvent): Promise<void> {
    try {
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
    } catch {
      // Audit must never break the main flow when DB is unavailable (first slice).
    }
  }
}
