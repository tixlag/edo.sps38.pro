import { describe, expect, it } from "vitest";
import {
  erpChangesSchema,
  groupErpChanges,
  settleCategory,
} from "../src/documents/erp-change-inbox";

const personUid = "d8a3bf7b-be71-4078-baff-2c401b318ab8";
const first = "635ff7b3-840b-42a3-8ccb-47f257d978f2";
const second = "53be764a-52e4-4345-ac52-d9b7f8eaab44";

describe("ERP change inbox", () => {
  it("combines person events without a candidateId and keeps the UUID namespaces separate", () => {
    const body = erpChangesSchema.parse({
      version: 1,
      items: [
        {
          eventId: first,
          target: "PERSON",
          uid: personUid.toUpperCase(),
          changes: ["DOCUMENTS"],
        },
        {
          eventId: second,
          target: "PERSON",
          uid: personUid,
          changes: ["ARRIVALS", "PROFILE"],
        },
        {
          eventId: first,
          target: "CANDIDATE",
          uid: personUid,
          changes: ["PROFILE"],
        },
      ],
    });
    expect(groupErpChanges(body.items)).toEqual([
      {
        target: "PERSON",
        uid: personUid,
        changes: new Set(["DOCUMENTS", "ARRIVALS", "PROFILE"]),
        eventKey: expect.any(String),
      },
      {
        target: "CANDIDATE",
        uid: personUid,
        changes: new Set(["PROFILE"]),
        eventKey: expect.any(String),
      },
    ]);
  });

  it("rejects raw document payloads and arrival events keyed as candidates", () => {
    expect(
      erpChangesSchema.safeParse({
        version: 1,
        items: [
          {
            eventId: first,
            target: "PERSON",
            uid: personUid,
            changes: ["PROFILE"],
            document: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      erpChangesSchema.safeParse({
        version: 1,
        items: [
          {
            eventId: first,
            target: "CANDIDATE",
            uid: personUid,
            changes: ["ARRIVALS"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps a later generation pending even when the previous one succeeds", () => {
    expect(settleCategory(5n, 4n, true)).toBe(5n);
    expect(settleCategory(4n, 4n, false)).toBe(4n);
    expect(settleCategory(4n, 4n, true)).toBe(0n);
  });
});
