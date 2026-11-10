import { describe, expect, it } from "vitest";
import {
  formatDateRu,
  formatLocalArrivalTime,
  formatDateTimeRu,
  isDateFieldName,
  maskDateRuInput,
  normalizeDateForApi,
  parseDateRu,
} from "./date-format";

describe("date-format", () => {
  it("preserves local ERP arrival time without timezone conversion or missing-time fallback", () => {
    expect(formatLocalArrivalTime("2026-11-10T14:35:42")).toBe("14:35");
    expect(formatLocalArrivalTime("2026-11-10T00:01:00")).toBe("00:01");
    expect(formatLocalArrivalTime("2026-11-10T00:00:00")).toBeUndefined();
    for (const value of [
      null,
      undefined,
      "",
      "2026-11-10",
      "2026-11-10T14:35:00Z",
      "2026-02-31T14:35:00",
      "2026-11-10T24:00:00",
    ]) {
      expect(formatLocalArrivalTime(value)).toBeUndefined();
    }
  });

  it("formats valid ISO dates strictly as dd.mm.yyyy", () => {
    expect(formatDateRu("1990-05-07")).toBe("07.05.1990");
    expect(formatDateRu("1990-02-31")).toBe("—");
    expect(formatDateRu("garbage")).toBe("—");
  });

  it("parses and masks Russian date entry", () => {
    expect(maskDateRuInput("07051990")).toBe("07.05.1990");
    expect(parseDateRu("07.05.1990")).toBe("1990-05-07");
    expect(parseDateRu("31.02.1990")).toBeUndefined();
    expect(normalizeDateForApi("07.05.1990")).toBe("1990-05-07");
    expect(normalizeDateForApi("1990-05-07")).toBe("1990-05-07");
  });

  it("keeps the date part of date-time output in the required format", () => {
    expect(formatDateTimeRu("2026-10-27T09:04:00.000Z")).toMatch(
      /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/,
    );
  });

  it("preserves the ISO calendar date when normalizing timestamps", () => {
    expect(normalizeDateForApi("1990-05-07T00:00:00.000Z")).toBe("1990-05-07");
    expect(formatDateRu("1990-05-07T00:00:00.000Z")).toBe("07.05.1990");
  });

  it("recognizes date fields without classifying adjacent text fields", () => {
    expect(isDateFieldName("issued_at")).toBe(true);
    expect(isDateFieldName("issueDate")).toBe(true);
    expect(isDateFieldName("pas_date_of_birth")).toBe(true);
    expect(isDateFieldName("birth_place")).toBe(false);
    expect(isDateFieldName("place_birth")).toBe(false);
    expect(isDateFieldName("pas_place_of_birth")).toBe(false);
    expect(isDateFieldName("issued_by")).toBe(false);
  });
});
