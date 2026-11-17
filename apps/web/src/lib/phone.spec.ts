import { expect, it } from "vitest";
import { formatPhoneForDisplay, normalizeRussianPhone } from "./phone";

it("normalizes proven Russian prefixes and preserves foreign or ambiguous numbers", () => {
  expect(normalizeRussianPhone("8 (900) 111-22-33")).toBe("+79001112233");
  expect(formatPhoneForDisplay("+7 900 111 22 33")).toBe("+7 (900) 111-22-33");
  for (const phone of [
    "9001112233",
    "+998901112233",
    "+996555123456",
    "+380501112233",
    "+81 901-112-233",
  ]) {
    expect(normalizeRussianPhone(phone)).toBe(phone);
    expect(formatPhoneForDisplay(phone)).toBe(phone);
  }
});
