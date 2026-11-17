import { describe, expect, it } from "vitest";
import { erpDocumentInstanceUid } from "../src/documents/erp-document-instance";

describe("ERP document instance identity", () => {
  it("maps a CUID to a stable canonical UUID without colliding with another document", () => {
    const first = erpDocumentInstanceUid("cm7dp38h00000b2bw16puucuv");
    const second = erpDocumentInstanceUid("cm7dp38h00001b2bw16puucuv");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).toBe(erpDocumentInstanceUid("cm7dp38h00000b2bw16puucuv"));
    expect(second).not.toBe(first);
  });
});
