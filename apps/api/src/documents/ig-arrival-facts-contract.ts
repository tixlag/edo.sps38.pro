import { z } from "zod";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const person = uuid.refine(
  (value) => value !== "00000000-0000-0000-0000-000000000000",
);
const calendar = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)
  .refine((value) => calendar.safeParse(value.slice(0, 10)).success);
const text = z.string().max(512).nullable();
const zeroUid = "00000000-0000-0000-0000-000000000000";

export const arrivalFactsPersonSchema = z
  .object({
    personUid: person,
    code1c: z.string().nullable(),
    participations: z.array(
      z.object({
        sourceKey: z.string().max(128),
        period: localDateTime,
        arrivalMemberUid: person.nullable(),
        arrivalDate: calendar.nullable(),
        arrivalDateTime: localDateTime.nullable(),
        locationUid: uuid.nullable(),
        locationCode1c: text,
        locationName: text,
        cancelled: z.boolean(),
        latestSiteStatusCancelled: z.boolean().nullable(),
        fullName: text,
        managerCode1c: text,
      }),
    ),
  })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const fact of value.participations) {
      const expected = `${fact.period}|${value.personUid}|${fact.locationUid ?? zeroUid}`;
      if (
        fact.arrivalDate &&
        fact.arrivalDateTime &&
        fact.arrivalDateTime.slice(0, 10) !== fact.arrivalDate
      ) {
        context.addIssue({
          code: "custom",
          message: "Arrival date and time disagree",
        });
      }
      if (fact.sourceKey !== expected || keys.has(fact.sourceKey)) {
        context.addIssue({
          code: "custom",
          message: "Invalid or duplicate source key",
        });
      }
      keys.add(fact.sourceKey);
    }
  });
export type ArrivalFactsPerson = z.infer<typeof arrivalFactsPersonSchema>;

export const arrivalFactsPageSchema = z.object({
  contractVersion: z.literal(2),
  items: z.array(z.unknown()).max(200),
  nextCursor: z.string().min(1).max(1024).nullable(),
  issues: z.array(z.unknown()),
});
