import { z } from 'zod';

const employeePayload = z.object({
  code1c: z.string(),
  uuid: z.string(),
  fullName: z.string(),
  birthday: z.string().nullable(),
  citizenship: z.string().nullable(),
  organization: z.object({ code: z.string().nullable(), name: z.string().nullable() }),
  position: z.object({ code1c: z.string().nullable(), name: z.string().nullable() }),
  department: z.object({ code1c: z.string().nullable(), name: z.string().nullable() }),
  division: z.object({ code1c: z.string().nullable(), name: z.string().nullable() }),
  lastLocation: z.union([z.object({ id: z.number(), code1c: z.string(), name: z.string() }), z.null()]),
  hireDate: z.string().nullable(),
  fired: z.boolean(),
  contractor: z.boolean(),
  updatedAt: z.string().nullable(),
});

const referencePayload = z.object({
  code1c: z.string(),
  name: z.string(),
  deleted: z.boolean(),
  updatedAt: z.string().nullable(),
});

export const lkEventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(['employee.upserted', 'position.upserted', 'department.upserted']),
  version: z.literal(1),
  occurredAt: z.string(),
  source: z.literal('lk.sps38.pro'),
  payload: z.unknown(),
});

export type LkEventEnvelope = z.infer<typeof lkEventEnvelopeSchema>;
export type LkEmployeePayload = z.infer<typeof employeePayload>;
export type LkReferencePayload = z.infer<typeof referencePayload>;

export function parseEmployeePayload(payload: unknown) {
  return employeePayload.parse(payload);
}

export function parseReferencePayload(payload: unknown) {
  return referencePayload.parse(payload);
}

/** Routing key -> eventType mapping (v1). Unknown keys must not be applied. */
export function eventTypeFromRoutingKey(routingKey: string): string | null {
  const map: Record<string, string> = {
    'lk.reference.employee.upserted.v1': 'employee.upserted',
    'lk.reference.position.upserted.v1': 'position.upserted',
    'lk.reference.department.upserted.v1': 'department.upserted',
  };
  return map[routingKey] ?? null;
}
