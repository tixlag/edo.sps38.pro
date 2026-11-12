import { describe, expect, it } from "vitest";
import { documentDeliveryPresentation } from "./document-delivery-presentation";

describe("document delivery presentation", () => {
  it("treats a confirmed historical ERP link as delivered without hiding real failures", () => {
    expect(documentDeliveryPresentation("APPROVED", null, true)).toMatchObject({
      label: "Ранее сохранён в ERP",
      tone: "success",
      problem: false,
    });
    expect(
      documentDeliveryPresentation("APPROVED", "REQUIRES_MANUAL", false),
    ).toMatchObject({
      label: "Не сохранён в ERP",
      tone: "danger",
      problem: true,
    });
    expect(
      documentDeliveryPresentation("SIGNED", "WAITING_CONTRACT", false),
    ).toMatchObject({
      label: "Отправка в ERP недоступна",
      tone: "warning",
      problem: true,
    });
  });
});
