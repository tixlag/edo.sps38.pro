import { createHash } from "node:crypto";
import { z } from "zod";
const uuid = z
  .string()
  .uuid()
  .refine((value) => value !== "00000000-0000-0000-0000-000000000000")
  .transform((value) => value.toLowerCase());
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
const nullableText = z.string().max(512).nullable();
export const arrivalParticipationSchema = z.object({
  arrivalMemberUid: uuid,
  arrivalDate: calendar.nullable(),
  arrivalDateTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/)
    .refine((value) => calendar.safeParse(value.slice(0, 10)).success)
    .nullable()
    .optional(),
  locationUid: uuid.nullable(),
  locationCode1c: nullableText,
  locationName: nullableText,
  cancelled: z.boolean(),
  fullName: nullableText.optional(),
  citizenship: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .nullable()
    .optional(),
  managerCode1c: nullableText.optional(),
});
export const arrivalStateSchema = z
  .object({
    personUid: uuid,
    code1c: z.string().regex(/^\S{1,64}$/),
    revision: z.number().int().positive().safe(),
    state: z.enum(["CURRENT", "NONE", "CONFLICT"]),
    currentArrivalMemberUid: uuid.nullable(),
    participations: z.array(arrivalParticipationSchema).max(500),
    conflictCode: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .optional(),
  })
  .superRefine((value, context) => {
    const ids = value.participations.map((item) => item.arrivalMemberUid);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Duplicate member" });
    if (value.state === "CURRENT") {
      if (
        !value.currentArrivalMemberUid ||
        value.participations.filter(
          (item) =>
            item.arrivalMemberUid === value.currentArrivalMemberUid &&
            !item.cancelled,
        ).length !== 1
      )
        context.addIssue({ code: "custom", message: "Invalid current member" });
    } else if (value.currentArrivalMemberUid !== null)
      context.addIssue({
        code: "custom",
        message: "Unexpected current member",
      });
  });
export const arrivalSourceIssueSchema = z.object({
  personUid: uuid,
  code: z.string().regex(/^[A-Z0-9_]{1,64}$/),
});
export const arrivalPageSchema = z.object({
  items: z.array(z.unknown()).max(200),
  nextCursor: z.string().min(1).max(1024).nullable(),
  issues: z.array(z.unknown()).max(100).optional(),
});
export type PersonArrivalState = z.infer<typeof arrivalStateSchema>;
export function arrivalStateHash(value: PersonArrivalState): string {
  const canonical = {
    ...value,
    participations: [...value.participations].sort((a, b) =>
      a.arrivalMemberUid.localeCompare(b.arrivalMemberUid),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
