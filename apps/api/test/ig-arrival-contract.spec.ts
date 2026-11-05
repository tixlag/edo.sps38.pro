import { describe, expect, it } from "vitest";
import {
  arrivalPageSchema,
  arrivalStateSchema,
  arrivalStateHash,
} from "../src/documents/ig-arrival-contract";
const personUid = "00000000-0000-4000-8000-000000000001";
const member = "00000000-0000-4000-8000-000000000002";
const current = {
  personUid,
  code1c: "worker",
  revision: 1,
  state: "CURRENT",
  currentArrivalMemberUid: member,
  participations: [
    {
      arrivalMemberUid: member,
      arrivalDate: "2026-11-05",
      locationUid: "00000000-0000-4000-8000-000000000003",
      locationCode1c: null,
      locationName: "Object",
      cancelled: false,
    },
  ],
};
describe("ERP arrival wire contract", () => {
  it("accepts a current calendar literal and stable member", () => {
    expect(arrivalStateSchema.parse(current)).toMatchObject(current);
  });
  it("requires explicit pagination end", () => {
    expect(arrivalPageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      arrivalPageSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
  });
  it.each([
    { ...current, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...current, currentArrivalMemberUid: null },
    {
      ...current,
      participations: [{ ...current.participations[0], cancelled: true }],
    },
    {
      ...current,
      participations: [current.participations[0], current.participations[0]],
    },
    {
      ...current,
      participations: [
        { ...current.participations[0], arrivalDate: "2026-02-30" },
      ],
    },
    { ...current, state: "NONE" },
  ])("rejects invalid or contradictory source state", (value) => {
    expect(arrivalStateSchema.safeParse(value).success).toBe(false);
  });
  it("isolates a malformed source issue without discarding valid page items", () => {
    const page = arrivalPageSchema.safeParse({
      items: [current],
      nextCursor: null,
      issues: [{ personUid: "invalid", code: "BAD" }],
    });
    expect(page.success).toBe(true);
  });
  it("does not treat order of historical members as a different revision", () => {
    const history = {
      ...current.participations[0],
      arrivalMemberUid: "00000000-0000-4000-8000-000000000004",
      cancelled: true,
    };
    const a = arrivalStateSchema.parse({
      ...current,
      participations: [current.participations[0], history],
    });
    const b = arrivalStateSchema.parse({
      ...current,
      participations: [history, current.participations[0]],
    });
    expect(arrivalStateHash(a)).toBe(arrivalStateHash(b));
  });
});
