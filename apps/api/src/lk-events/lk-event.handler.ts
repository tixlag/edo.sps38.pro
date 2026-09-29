import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LkReferenceSyncService } from '../lk-sync/lk-reference-sync.service';
import {
  eventTypeFromRoutingKey,
  lkEventEnvelopeSchema,
  parseEmployeePayload,
  parseReferencePayload,
} from './lk-event.schema';

export type EventApplyOutcome =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string };

/**
 * Applies LK RabbitMQ events idempotently:
 * - validates envelope (version must be 1, source must be lk.sps38.pro),
 * - deduplicates by eventId via lk_processed_events (re-delivery safe),
 * - upserts the Lk* projection in the same DB transaction as the inbox row,
 * - out-of-order safe as far as possible (no version column from LK; full
 *   reconciliation via snapshot fixes divergence).
 * Malformed/unknown-version/unknown-key events return `ignored` (caller acks,
 * never requeues poison).
 */
@Injectable()
export class LkEventHandler {
  private readonly logger = new Logger(LkEventHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: LkReferenceSyncService,
    private readonly audit: AuditService,
  ) {}

  async applyRaw(routingKey: string, raw: Buffer): Promise<EventApplyOutcome> {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 'ignored', reason: 'malformed-json' };
    }
    const expected = eventTypeFromRoutingKey(routingKey);
    if (!expected) {
      return { status: 'ignored', reason: `unknown-routing-key:${routingKey}` };
    }
    const parsed = lkEventEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ');
      this.logger.warn(`Ignoring malformed LK event: ${msg.slice(0, 300)}`);
      return { status: 'ignored', reason: `malformed-envelope:${msg.slice(0, 200)}` };
    }
    const envelope = parsed.data;
    if (envelope.eventType !== expected) {
      return { status: 'ignored', reason: 'event-type-routing-key-mismatch' };
    }
    return this.applyEnvelope(envelope);
  }

  async applyEnvelope(envelope: {
    eventId: string;
    eventType: 'employee.upserted' | 'position.upserted' | 'department.upserted';
    version: 1;
    occurredAt: string;
    source: 'lk.sps38.pro';
    payload?: unknown;
  }): Promise<EventApplyOutcome> {
    if (envelope.payload === undefined || envelope.payload === null) {
      return { status: 'ignored', reason: 'missing-payload' };
    }
    const existing = await this.prisma.lkProcessedEvent.findUnique({
      where: { eventId: envelope.eventId },
    });
    if (existing) return { status: 'duplicate' };

    const occurredAt = toDateOrNull(envelope.occurredAt);
    try {
      if (envelope.eventType === 'employee.upserted') {
        const payload = parseEmployeePayload(envelope.payload);
        await this.prisma.$transaction(async (tx) => {
          await tx.lkProcessedEvent.create({
            data: {
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              version: envelope.version,
              occurredAt,
              entityCode: payload.code1c,
            },
          });
          await this.upsertEmployeeTx(tx as never, payload);
          await this.audit.logInTransaction(tx as never, {
            action: 'LK_EVENT_APPLIED',
            entityType: 'LkEmployee',
            entityId: payload.code1c,
            after: { eventId: envelope.eventId },
          });
        });
      } else if (envelope.eventType === 'position.upserted') {
        const payload = parseReferencePayload(envelope.payload);
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          await tx.lkProcessedEvent.create({
            data: {
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              version: envelope.version,
              occurredAt,
              entityCode: payload.code1c,
            },
          });
          await tx.lkPosition.upsert({
            where: { code1c: payload.code1c },
            update: { name: payload.name, deleted: payload.deleted, syncedAt: now },
            create: { code1c: payload.code1c, name: payload.name, deleted: payload.deleted, syncedAt: now },
          });
        });
      } else {
        const payload = parseReferencePayload(envelope.payload);
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          await tx.lkProcessedEvent.create({
            data: {
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              version: envelope.version,
              occurredAt,
              entityCode: payload.code1c,
            },
          });
          await tx.lkDepartment.upsert({
            where: { code1c: payload.code1c },
            update: { name: payload.name, deleted: payload.deleted, syncedAt: now },
            create: { code1c: payload.code1c, name: payload.name, deleted: payload.deleted, syncedAt: now },
          });
        });
      }
      return { status: 'applied' };
    } catch (err) {
      // Unique violation on eventId raced by concurrent consumer -> duplicate.
      if (isUniqueViolation(err)) return { status: 'duplicate' };
      throw err;
    }
  }

  private async upsertEmployeeTx(tx: never, payload: ReturnType<typeof parseEmployeePayload>) {
    const t = tx as unknown as PrismaService;
    const now = new Date();
    await t.lkEmployee.upsert({
      where: { code1c: payload.code1c },
      update: {
        uuid: payload.uuid,
        fullName: payload.fullName,
        birthday: toDateOrNull(payload.birthday),
        citizenship: payload.citizenship,
        organizationCode: payload.organization.code,
        organizationName: payload.organization.name,
        positionCode1c: payload.position.code1c,
        positionName: payload.position.name,
        departmentCode1c: payload.department.code1c,
        departmentName: payload.department.name,
        divisionCode1c: payload.division.code1c,
        divisionName: payload.division.name,
        lastLocationId: payload.lastLocation?.id ?? null,
        lastLocationCode1c: payload.lastLocation?.code1c ?? null,
        lastLocationName: payload.lastLocation?.name ?? null,
        hireDate: toDateOrNull(payload.hireDate),
        fired: payload.fired,
        contractor: payload.contractor,
        syncedAt: now,
      },
      create: {
        code1c: payload.code1c,
        uuid: payload.uuid,
        fullName: payload.fullName,
        birthday: toDateOrNull(payload.birthday),
        citizenship: payload.citizenship,
        organizationCode: payload.organization.code,
        organizationName: payload.organization.name,
        positionCode1c: payload.position.code1c,
        positionName: payload.position.name,
        departmentCode1c: payload.department.code1c,
        departmentName: payload.department.name,
        divisionCode1c: payload.division.code1c,
        divisionName: payload.division.name,
        lastLocationId: payload.lastLocation?.id ?? null,
        lastLocationCode1c: payload.lastLocation?.code1c ?? null,
        lastLocationName: payload.lastLocation?.name ?? null,
        hireDate: toDateOrNull(payload.hireDate),
        fired: payload.fired,
        contractor: payload.contractor,
        syncedAt: now,
      },
    });
    void this.sync;
  }
}

function toDateOrNull(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string };
  return e?.code === 'P2002';
}
