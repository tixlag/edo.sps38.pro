import { describe, expect, it, vi } from "vitest";
import {
  candidateInitials,
  documentProgressPercent,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
  hasActiveReviewFilters,
  lkEmployeeUrl,
  parseReviewSearchParams,
} from "./review-groups";

describe("formatBirthDateRu", () => {
  it("formats YYYY-MM-DD as dd.MM.yyyy", () => {
    expect(formatBirthDateRu("1990-05-17")).toBe("17.05.1990");
    expect(formatBirthDateRu(null)).toBe("—");
    expect(formatBirthDateRu("garbage")).toBe("—");
    expect(formatBirthDateRu("1990-02-31")).toBe("—");
  });
});

describe("candidateInitials", () => {
  it("takes first letters of the first two name parts", () => {
    expect(candidateInitials("Иванова Анна Сергеевна")).toBe("ИА");
    expect(candidateInitials("  Пётр  ")).toBe("П");
    expect(candidateInitials(null)).toBe("?");
    expect(candidateInitials("   ")).toBe("?");
  });
});

describe("lkEmployeeUrl", () => {
  it("returns null without a 1C code and encodes the code", () => {
    expect(lkEmployeeUrl(null)).toBeNull();
    expect(lkEmployeeUrl("")).toBeNull();
    vi.stubEnv("VITE_LK_BASE_URL", "https://lk.example.test/");
    expect(lkEmployeeUrl("АБ 123/45")).toBe(
      "https://lk.example.test/public/employee/%D0%90%D0%91%20123%2F45?size_width=WIDE_1200",
    );
    vi.unstubAllEnvs();
  });

  it("falls back to the production LK base", () => {
    vi.stubEnv("VITE_LK_BASE_URL", "");
    expect(lkEmployeeUrl("0001")).toBe(
      "https://lk.sps38.pro/public/employee/0001?size_width=WIDE_1200",
    );
    vi.unstubAllEnvs();
  });
});

describe("formatCandidateObject", () => {
  it("renders the full object line and an em dash when unknown", () => {
    expect(formatCandidateObject("ТЦ Север", "PRJ1")).toBe(
      "Объект: ТЦ Север (PRJ1)",
    );
    expect(formatCandidateObject("ТЦ Север", null)).toBe("Объект: ТЦ Север");
    expect(formatCandidateObject(null, "PRJ1")).toBe("Объект: (PRJ1)");
    expect(formatCandidateObject(null, null)).toBe("Объект: —");
    expect(formatCandidateObject("  ", undefined)).toBe("Объект: —");
  });
});

describe("formatDocumentProgress", () => {
  it("counts approved against the catalog total", () => {
    expect(formatDocumentProgress(3, 5)).toBe("Подтверждено 3 из 5");
    expect(formatDocumentProgress(0, 0)).toBe("Подтверждено 0 из 0");
  });

  it("explains the unknown total when there is no position", () => {
    expect(formatDocumentProgress(1, null)).toBe(
      "Подтверждено 1 · всего ожидается: неизвестно (нет должности)",
    );
    expect(formatDocumentProgress(1, undefined)).toBe(
      "Подтверждено 1 · всего ожидается: неизвестно (нет должности)",
    );
  });
});

describe("documentProgressPercent", () => {
  it("returns a clamped percent and null without a usable total", () => {
    expect(documentProgressPercent(3, 5)).toBe(60);
    expect(documentProgressPercent(7, 5)).toBe(100);
    expect(documentProgressPercent(0, 5)).toBe(0);
    expect(documentProgressPercent(1, null)).toBeNull();
    expect(documentProgressPercent(1, undefined)).toBeNull();
    expect(documentProgressPercent(0, 0)).toBeNull();
  });
});

describe("parseReviewSearchParams", () => {
  it("parses every filter field and rejects invalid status/dates", () => {
    const filters = parseReviewSearchParams({
      status: "RETURNED",
      candidateId: "cand-1",
      documentTypeCode: "PASSPORT",
      citizenship: "RU",
      managerCode1c: "M001",
      mentorCode1c: "N001",
      hasMentor: "true",
      birthDateFrom: "1990-01-01",
      birthDateTo: "not-a-date",
      positionCode: "POS1",
      projectCode: "PRJ1",
      cursor: "abc",
      candidate: "cand-1",
    });
    expect(filters).toEqual({
      status: "RETURNED",
      candidateId: "cand-1",
      documentTypeCode: "PASSPORT",
      citizenship: "RU",
      managerCode1c: "M001",
      mentorCode1c: "N001",
      hasMentor: true,
      birthDateFrom: "1990-01-01",
      birthDateTo: undefined,
      positionCode: "POS1",
      projectCode: "PRJ1",
      cursor: "abc",
      candidate: "cand-1",
    });
  });

  it("falls back to IN_REVIEW and maps hasMentor=false", () => {
    const filters = parseReviewSearchParams({
      status: "BOGUS",
      hasMentor: "false",
      candidateId: "   ",
    });
    expect(filters.status).toBe("IN_REVIEW");
    expect(filters.hasMentor).toBe(false);
    expect(filters.candidateId).toBeUndefined();
    expect(hasActiveReviewFilters(filters)).toBe(true);
  });

  it("reports no active filters for a clean queue request", () => {
    expect(hasActiveReviewFilters(parseReviewSearchParams({}))).toBe(false);
    expect(
      hasActiveReviewFilters(
        parseReviewSearchParams({ status: "IN_REVIEW", cursor: "x" }),
      ),
    ).toBe(false);
  });

  it("ignores the drawer selection when detecting active filters", () => {
    expect(
      hasActiveReviewFilters(parseReviewSearchParams({ candidate: "cand-1" })),
    ).toBe(false);
    expect(
      hasActiveReviewFilters(
        parseReviewSearchParams({ candidate: "cand-1", citizenship: "RU" }),
      ),
    ).toBe(true);
  });
});
