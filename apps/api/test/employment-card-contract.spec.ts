import { describe, expect, it } from "vitest";
import { erpCardSchema } from "../src/documents/erp-workspace.client";
const schema = erpCardSchema.pick({
  employmentConfirmed: true,
  employmentConfirmationId: true,
  employmentNotificationRecipientCodes1c: true,
});
describe("authoritative ERP employment notification fields", () => {
  it("defaults older ERP cards to no employment claim and no recipients", () => {
    expect(schema.parse({})).toEqual({
      employmentConfirmed: false,
      employmentConfirmationId: null,
      employmentNotificationRecipientCodes1c: [],
    });
  });
  it("accepts stable hire identity and explicit employee codes", () => {
    expect(
      schema.parse({
        employmentConfirmed: true,
        employmentConfirmationId:
          "hire:123e4567-e89b-12d3-a456-426614174000:20261116",
        employmentNotificationRecipientCodes1c: ["УП000123"],
      }),
    ).toMatchObject({
      employmentConfirmed: true,
      employmentNotificationRecipientCodes1c: ["УП000123"],
    });
  });
  it.each([
    { employmentConfirmed: "true" },
    { employmentConfirmationId: "2026-11-16" },
    {
      employmentConfirmationId:
        "hire:------------------------------------:20261116",
    },
    { employmentNotificationRecipientCodes1c: [""] },
    { employmentNotificationRecipientCodes1c: [{ id: "erp-user" }] },
  ])(
    "rejects malformed employment facts or recipient identities %j",
    (payload) => {
      expect(schema.safeParse(payload).success).toBe(false);
    },
  );
});
