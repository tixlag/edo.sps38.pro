import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LkReferenceSyncService } from '../lk-sync/lk-reference-sync.service';
import { DbFencingService } from '../lk-sync/lk-fencing.service';
import {
  eventTypeFromRoutingKey,
  lkEventEnvelopeSchema,
  parseEmployeePayload,
  parseReferencePayload,
} from './lk-event.schema';

export type EventApplyOutcome =
  | { status: 'applied' }
  | { status: 'duplicate' }
  | { status: 'poison'; reason: string };

/**
 * Applies LK RabbitMQ events idempotently:
 * - validates envelope (version must be 1, source must be lk.sps38.pro),
 * - deduplicates by eventId via lk_processed_events (re-delivery safe),
 * - upserts the Lk* projection in the same DB transaction as the inbox row
 *   plus audit (all three event types; ack only after commit),
 * - fencing: the same transaction first takes SELECT ... FOR UPDATE on the
 *   `lk_sync_state` row and requires no active snapshot (see DbFencingService).
 *   Late admits abort as transient and redeliver after the snapshot.
 *   LK publishes no monotonic entity revision (updatedAt is always null;
 *   occurredAt/eventId are NOT versions — see LK docs/integrations/edo.md),
 *   so ordering between different eventIds of one entity is last-writer-wins
 *   and divergence is repaired by periodic full reconciliation. The inbox
 *   guarantees no double-apply of the SAME eventId, nothing more.
 *
 * Error classification (no infinite poison requeue):
 * - poison (caller must nack requeue=false -> DLQ): invalid JSON, invalid
 *   envelope, unsupported version, unknown routing key, eventType mismatch,
 *   missing payload, invalid domain payload (ZodError). Logged with
 *   eventId/routingKey/reason only, never the full employee payload.
 * - transient (throw -> caller retries via confirm-gated retry queue): MariaDB/
 *   network errors, fencing conflicts (snapshot RUNNING), P2002 on non-inbox
 *   constraints (re-thrown, never acked as duplicate).
 * - duplicate (caller acks): already-seen eventId, confirmed via re-read after
 *   P2002. A P2002 that is NOT on lk_processed_events.eventId is never
 *   treated as duplicate (it would lose the conflict via ack).
 */
@Injectable()
export class LkEventHandler {
  private readonly logger = new Logger(LkEventHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: LkReferenceSyncService,
    private readonly audit: AuditService,
    private readonly fencing: DbFencingService,
  ) {}

  async applyRaw(routingKey: string, raw: Buffer): Promise<EventApplyOutcome> {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn(`LK poison event malformed-json routingKey=${routingKey}`);
      return { status: 'poison', reason: 'malformed-json' };
    }
    const expected = eventTypeFromRoutingKey(routingKey);
    if (!expected) {
      this.logger.warn(`LK poison event unknown-routing-key routingKey=${routingKey}`);
      return { status: 'poison', reason: `unknown-routing-key:${routingKey.slice(0, 120)}` };
    }
    const parsed = lkEventEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ');
      this.logger.warn(
        `LK poison event malformed-envelope routingKey=${routingKey} reason=${msg.slice(0, 200)}`,
      );
      return { status: 'poison', reason: `malformed-envelope:${msg.slice(0, 200)}` };
    }
    const envelope = parsed.data;
    if (envelope.eventType !== expected) {
      this.logger.warn(
        `LK poison event event-type-routing-key-mismatch routingKey=${routingKey} eventType=${envelope.eventType}`,
      );
      return { status: 'poison', reason: 'event-type-routing-key-mismatch' };
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
      this.logger.warn(`LK poison event missing-payload eventId=${envelope.eventId}`);
      return { status: 'poison', reason: 'missing-payload' };
    }
    const existing = await this.prisma.lkProcessedEvent.findUnique({
      where: { eventId: envelope.eventId },
    });
    if (existing) return { status: 'duplicate' };

    const occurredAt = toDateOrNull(envelope.occurredAt);
    try {
      if (envelope.eventType === 'employee.upserted') {
        let payload: ReturnType<typeof parseEmployeePayload>;
        try {
          payload = parseEmployeePayload(envelope.payload);
        } catch (err) {
          this.logger.warn(
            `LK poison event invalid-employee-payload eventId=${envelope.eventId} reason=${poisonReason(err)}`,
          );
          return { status: 'poison', reason: `invalid-employee-payload:${poisonReason(err)}` };
        }
        await this.prisma.$transaction(async (tx) => {
          // Fencing gate INSIDE the write transaction: SELECT ... FOR UPDATE
          // on the coordination row serializes against snapshot acquire/page
          // transactions. Any gate SQL error propagates as transient (the
          // caller slow-requeues); it is never swallowed as "probably a mock".
          await this.fencing.assertEventMayWrite(tx as never, envelope.eventId);
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
        let payload: ReturnType<typeof parseReferencePayload>;
        try {
          payload = parseReferencePayload(envelope.payload);
        } catch (err) {
          this.logger.warn(
            `LK poison event invalid-position-payload eventId=${envelope.eventId} reason=${poisonReason(err)}`,
          );
          return { status: 'poison', reason: `invalid-position-payload:${poisonReason(err)}` };
        }
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          // Fencing gate INSIDE the write transaction: SELECT ... FOR UPDATE
          // on the coordination row serializes against snapshot acquire/page
          // transactions. Any gate SQL error propagates as transient (the
          // caller slow-requeues); it is never swallowed as "probably a mock".
          await this.fencing.assertEventMayWrite(tx as never, envelope.eventId);
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
          await this.audit.logInTransaction(tx as never, {
            action: 'LK_EVENT_APPLIED',
            entityType: 'LkPosition',
            entityId: payload.code1c,
            after: { eventId: envelope.eventId },
          });
        });
      } else {
        let payload: ReturnType<typeof parseReferencePayload>;
        try {
          payload = parseReferencePayload(envelope.payload);
        } catch (err) {
          this.logger.warn(
            `LK poison event invalid-department-payload eventId=${envelope.eventId} reason=${poisonReason(err)}`,
          );
          return { status: 'poison', reason: `invalid-department-payload:${poisonReason(err)}` };
        }
        const now = new Date();
        await this.prisma.$transaction(async (tx) => {
          // Fencing gate INSIDE the write transaction: SELECT ... FOR UPDATE
          // on the coordination row serializes against snapshot acquire/page
          // transactions. Any gate SQL error propagates as transient (the
          // caller slow-requeues); it is never swallowed as "probably a mock".
          await this.fencing.assertEventMayWrite(tx as never, envelope.eventId);
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
          await this.audit.logInTransaction(tx as never, {
            action: 'LK_EVENT_APPLIED',
            entityType: 'LkDepartment',
            entityId: payload.code1c,
            after: { eventId: envelope.eventId },
          });
        });
      }
      return { status: 'applied' };
    } catch (err) {
      // P2002 is duplicate ONLY when the inbox row for THIS eventId now exists.
      // Any other unique conflict (e.g. LkLocation.locationId, Employee keys)
      // must NOT be acked as duplicate — rethrow as transient so the conflict
      // is investigated instead of silently lost.
      if (isUniqueViolation(err)) {
        const confirmed = await this.prisma.lkProcessedEvent
          .findUnique({ where: { eventId: envelope.eventId } })
          .catch(() => null);
        if (confirmed) return { status: 'duplicate' };
        this.logger.error(
          `LK event P2002 not on inbox eventId=${envelope.eventId}; rethrowing as transient (no ack)`,
        );
        throw err;
      }
      if (isPoisonError(err)) {
        this.logger.warn(
          `LK poison event apply eventId=${envelope.eventId} reason=${poisonReason(err)}`,
        );
        return { status: 'poison', reason: `invalid-payload:${poisonReason(err)}` };
      }
      // Fencing conflicts/unavailability and all other errors are transient:
      // the caller retries via the confirm-gated retry queue / slow-requeue.
      // (FencingConflictError/FencingUnavailableError are plain Errors, never
      // ZodError, so they correctly land here and never in the poison branch.)
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
        sourcePresent: true,
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
        sourcePresent: true,
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

function isPoisonError(err: unknown): boolean {
  const e = err as { name?: string; issues?: unknown };
  return e?.name === 'ZodError' || Array.isArray(e?.issues);
}

function poisonReason(err: unknown): string {
  // Safe by construction (not just by truncation): our payload/envelope schemas
  // contain no enum/literal value constraints, so Zod messages carry only
  // field paths + expected-type names, never payload values. Equal-type
  // mismatches (e.g. source/eventType literals) echo only protocol constants.
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
