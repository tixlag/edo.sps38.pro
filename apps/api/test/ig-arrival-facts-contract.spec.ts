import { describe, expect, it } from "vitest";
import { arrivalFactsPersonSchema } from "../src/documents/ig-arrival-facts-contract";

const personUid = "00000000-0000-4000-8000-000000000001";
const locationUid = "00000000-0000-4000-8000-000000000003";
const period = "2026-11-05T13:20:45";
const fact = {
  sourceKey: `${period}|${personUid}|${locationUid}`,
  period,
  arrivalMemberUid: null,
  arrivalDate: "2026-11-06",
  arrivalDateTime: null,
  locationUid,
  locationCode1c: null,
  locationName: null,
  cancelled: false,
  fullName: null,
  managerCode1c: null,
  latestSiteStatusCancelled: null,
};

describe("ERP factual arrival contract", () => {
  it("accepts a legacy fact without code or UUID, independently of arrival date", () => {
    expect(
      arrivalFactsPersonSchema.parse({
        personUid,
        code1c: null,
        participations: [fact],
      }).participations[0],
    ).toMatchObject(fact);
  });
  it("rejects a source key that does not match all source dimensions", () => {
    expect(
      arrivalFactsPersonSchema.safeParse({
        personUid,
        code1c: null,
        participations: [
          {
            ...fact,
            sourceKey: `${period}|${personUid}|00000000-0000-0000-0000-000000000000`,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects repeated source keys but accepts repeated source UUIDs", () => {
    expect(
      arrivalFactsPersonSchema.safeParse({
        personUid,
        code1c: null,
        participations: [fact, fact],
      }).success,
    ).toBe(false);
    const uid = "00000000-0000-4000-8000-000000000002";
    const period2 = "2026-11-05T13:20:46";
    expect(
      arrivalFactsPersonSchema.safeParse({
        personUid,
        code1c: null,
        participations: [
          { ...fact, arrivalMemberUid: uid },
          {
            ...fact,
            period: period2,
            sourceKey: `${period2}|${personUid}|${locationUid}`,
            arrivalMemberUid: uid,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("site status is separate from a factual cancellation", () => {
  it.each([true, false, null])(
    "preserves site status %s without cancelling the source row",
    (status) => {
      const parsed = arrivalFactsPersonSchema.parse({
        personUid,
        code1c: null,
        participations: [{ ...fact, latestSiteStatusCancelled: status }],
      });
      expect(parsed.participations[0]).toMatchObject({
        cancelled: false,
        latestSiteStatusCancelled: status,
      });
    },
  );

  it("accepts the same site status on distinct source keys without choosing one participation", () => {
    const period2 = "2026-11-05T13:20:46";
    const participations = [
      { ...fact, latestSiteStatusCancelled: true },
      {
        ...fact,
        period: period2,
        sourceKey: `${period2}|${personUid}|${locationUid}`,
        latestSiteStatusCancelled: true,
      },
    ];
    const parsed = arrivalFactsPersonSchema.parse({
      personUid,
      code1c: null,
      participations,
    });
    expect(parsed.participations).toHaveLength(2);
    expect(
      parsed.participations.every(
        (row) => !row.cancelled && row.latestSiteStatusCancelled,
      ),
    ).toBe(true);
  });

  it("preserves an empty location as a zero UUID only in the complete source key", () => {
    const parsed = arrivalFactsPersonSchema.parse({
      personUid,
      code1c: null,
      participations: [
        {
          ...fact,
          locationUid: null,
          sourceKey: `${period}|${personUid}|00000000-0000-0000-0000-000000000000`,
        },
      ],
    });
    expect(parsed.participations[0].locationUid).toBeNull();
  });
});

describe("ERP factual page contract", () => {
  it("requires an explicit version and pagination end before processing", async () => {
    const { arrivalFactsPageSchema } =
      await import("../src/documents/ig-arrival-facts-contract");
    expect(
      arrivalFactsPageSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(false);
    expect(
      arrivalFactsPageSchema.safeParse({
        contractVersion: 1,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      arrivalFactsPageSchema.safeParse({ contractVersion: 2, items: [] })
        .success,
    ).toBe(false);
    expect(
      arrivalFactsPageSchema.safeParse({
        contractVersion: 2,
        items: [],
        nextCursor: null,
        issues: [],
      }).success,
    ).toBe(true);
  });
});

describe("large factual groups", () => {
  it("accepts more than 500 facts and 100 issues without discarding the person", async () => {
    const { arrivalFactsPageSchema } =
      await import("../src/documents/ig-arrival-facts-contract");
    const facts = Array.from({ length: 501 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 0, 1, 0, 0, i))
        .toISOString()
        .slice(0, 19);
      return {
        ...fact,
        period: date,
        sourceKey: `${date}|${personUid}|${locationUid}`,
      };
    });
    expect(
      arrivalFactsPersonSchema.safeParse({
        personUid,
        code1c: null,
        participations: facts,
      }).success,
    ).toBe(true);
    expect(
      arrivalFactsPageSchema.safeParse({
        contractVersion: 2,
        items: [],
        nextCursor: null,
        issues: Array.from({ length: 101 }, () => ({
          code: "DUPLICATE_ARRIVAL_MEMBER_UID",
        })),
      }).success,
    ).toBe(true);
  });
  it("rejects contradictory local date and time", () => {
    expect(
      arrivalFactsPersonSchema.safeParse({
        personUid,
        code1c: null,
        participations: [
          {
            ...fact,
            arrivalDate: "2026-11-06",
            arrivalDateTime: "2026-11-07T12:00:00",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
