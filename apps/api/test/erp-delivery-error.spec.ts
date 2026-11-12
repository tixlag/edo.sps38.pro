import { describe, expect, it } from "vitest";
import { erpDeliveryReason } from "../src/documents/erp-delivery-error";

describe("ERP delivery reasons", () => {
  it("explains the known machine codes in plain language", () => {
    expect(erpDeliveryReason("ERP_INVALID_FILE_CONTENT")).toBe(
      "1С отклонила файл: некорректный формат",
    );
    expect(erpDeliveryReason("ERP_DOCUMENT_ALREADY_EXISTS")).toBe(
      "1С: документ за эту дату уже есть",
    );
    expect(erpDeliveryReason("ERP_HTTP_422")).toBe("1С отклонила файл");
  });

  it("never exposes an unknown code", () => {
    expect(erpDeliveryReason("PRIVATE_ERROR")).toBeNull();
    expect(erpDeliveryReason(null)).toBeNull();
    expect(erpDeliveryReason(undefined)).toBeNull();
  });
});
