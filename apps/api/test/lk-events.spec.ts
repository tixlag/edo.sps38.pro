import { describe, expect, it, vi } from 'vitest';
import { LkEventHandler } from '../src/lk-events/lk-event.handler';

function envelope(eventId: string, eventType: 'employee.upserted', fired = false) {
  return {
    eventId,
    eventType,
    version: 1 as const,
    occurredAt: '2026-09-29T08:15:00Z',
    source: 'lk.sps38.pro' as const,
    payload: {
      code1c: 'УП00023070',
      uuid: '00000000-0000-0000-0000-000000000001',
      fullName: 'Иванов Иван',
      birthday: null,
      citizenship: null,
      organization: { code: null, name: null },
      position: { code1c: null, name: null },
      department: { code1c: null, name: null },
      division: { code1c: null, name: null },
      lastLocation: null,
      hireDate: null,
      fired,
      contractor: false,
      updatedAt: null,
    },
  };
}

function handlerWithMemory(opts: { transientOnUpsert?: boolean } = {}) {
  const employees = new Map<string, unknown>();
  const events = new Map<string, unknown>();
  const txClient = {
    lkProcessedEvent: {
      create: async ({ data }: { data: { eventId: string } }) => {
        if (events.has(data.eventId)) {
          const err = new Error('Unique constraint') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        events.set(data.eventId, data);
        return data;
      },
    },
    lkEmployee: {
      upsert: async ({ where, update, create }: { where: { code1c: string }; update: object; create: object }) => {
        if (opts.transientOnUpsert) {
          const err = new Error('MariaDB temporarily unavailable') as Error & { code: string };
          err.code = 'P1001';
          throw err;
        }
        employees.set(where.code1c, { ...create, ...update });
        return employees.get(where.code1c);
      },
    },
    lkPosition: { upsert: async () => ({}) },
    lkDepartment: { upsert: async () => ({}) },
  };
  const prisma = {
    lkProcessedEvent: {
      findUnique: async ({ where }: { where: { eventId: string } }) =>
        events.has(where.eventId) ? { eventId: where.eventId } : null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
  } as never;
  const sync = {} as never;
  const audit = { logInTransaction: vi.fn() } as never;
  const handler = new LkEventHandler(prisma, sync, audit);
  return { handler, events, employees };
}

describe('LkEventHandler (RabbitMQ consumer)', () => {
  it('applies upsert and deduplicates the same eventId', async () => {
    const { handler, events, employees } = handlerWithMemory();
    const env = envelope('evt-1', 'employee.upserted');
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'applied' });
    expect(employees.has('УП00023070')).toBe(true);
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'duplicate' });
    expect(events.size).toBe(1);
  });

  it('acks duplicates via raw path (re-delivery safe)', async () => {
    const { handler } = handlerWithMemory();
    const env = envelope('evt-2', 'employee.upserted');
    const raw = Buffer.from(JSON.stringify(env));
    expect(await handler.applyRaw('lk.reference.employee.upserted.v1', raw)).toEqual({ status: 'applied' });
    expect(await handler.applyRaw('lk.reference.employee.upserted.v1', raw)).toEqual({ status: 'duplicate' });
  });

  it('poisons malformed JSON (DLQ, no throw, no requeue)', async () => {
    const { handler } = handlerWithMemory();
    const res = await handler.applyRaw('lk.reference.employee.upserted.v1', Buffer.from('not-json'));
    expect(res.status).toBe('poison');
  });

  it('poisons unknown versions (DLQ, no throw)', async () => {
    const { handler } = handlerWithMemory();
    const bad = { ...envelope('evt-3', 'employee.upserted'), version: 2 };
    const res = await handler.applyRaw(
      'lk.reference.employee.upserted.v1',
      Buffer.from(JSON.stringify(bad)),
    );
    expect(res.status).toBe('poison');
  });

  it('poisons unknown routing keys', async () => {
    const { handler } = handlerWithMemory();
    const raw = Buffer.from(JSON.stringify(envelope('evt-4', 'employee.upserted')));
    const res = await handler.applyRaw('lk.reference.unknown.v9', raw);
    expect(res.status).toBe('poison');
  });

  it('poisons invalid employee payload (ZodError -> DLQ, not infinite requeue)', async () => {
    const { handler, employees } = handlerWithMemory();
    const bad = {
      ...envelope('evt-poison', 'employee.upserted'),
      payload: { code1c: 123, uuid: null },
    };
    const res = await handler.applyRaw(
      'lk.reference.employee.upserted.v1',
      Buffer.from(JSON.stringify(bad)),
    );
    expect(res.status).toBe('poison');
    expect(employees.has('УП00023070')).toBe(false);
  });

  it('poisons eventType/routingKey mismatch', async () => {
    const { handler } = handlerWithMemory();
    const env = { ...envelope('evt-mismatch', 'employee.upserted'), eventType: 'position.upserted' as never };
    // Envelope says position but routing key says employee -> mismatch.
    const res = await handler.applyRaw(
      'lk.reference.employee.upserted.v1',
      Buffer.from(JSON.stringify({ ...env, eventType: 'position.upserted' })),
    );
    expect(res.status).toBe('poison');
  });

  it('retries transient DB errors (throw -> requeue)', async () => {
    const { handler } = handlerWithMemory({ transientOnUpsert: true });
    const env = envelope('evt-transient', 'employee.upserted');
    await expect(handler.applyEnvelope(env)).rejects.toThrow(/MariaDB/);
  });

  it('applies fired:true as upsert (not physical delete)', async () => {
    const { handler, employees } = handlerWithMemory();
    const env = envelope('evt-5', 'employee.upserted', true);
    expect(await handler.applyEnvelope(env)).toEqual({ status: 'applied' });
    expect((employees.get('УП00023070') as { fired: boolean }).fired).toBe(true);
  });
});
