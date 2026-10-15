import { describe, expect, it, vi } from "vitest";
import type { CandidateProfileDto, DocumentDto } from "@edo/api-client";
import {
  candidateInitials,
  documentProgressPercent,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
  groupReviewItems,
  hasActiveReviewFilters,
  lkEmployeeUrl,
  parseReviewSearchParams,
  reviewGroupKey,
} from "./review-groups";

function candidate(overrides: Partial<CandidateProfileDto>): CandidateProfileDto {
  return {
    id: "cand-1",
    chatUuid: null,
    code1c: null,
    fullName: null,
    birthDate: null,
    citizenship: null,
    positionCode: null,
    positionName: null,
    projectCode: null,
    projectName: null,
    managerName: null,
    managerCode1c: null,
    mentorName: null,
    mentorPosition: null,
    mentorCode1c: null,
    isReemployment: false,
    profileSyncedAt: null,
    approvedDocuments: 0,
    requiredDocuments: null,
    ...overrides,
  };
}

function doc(id: string, overrides: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id,
    title: `Документ ${id}`,
    documentTypeCode: "PASSPORT",
    documentUid: null,
    status: "IN_REVIEW",
    currentVersion: 1,
    revision: 0,
    candidateId: null,
    chatUuid: null,
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    candidate: null,
    ...overrides,
  };
}

describe("reviewGroupKey", () => {
  it("prefers candidate profile id over document fallbacks", () => {
    const d = doc("d1", {
      candidateId: "cand-doc",
      chatUuid: "chat-doc",
      candidate: candidate({ id: "cand-profile" }),
    });
    expect(reviewGroupKey(d)).toBe("cand-profile");
  });

  it("falls back to chatUuid/code1c and finally the document id", () => {
    expect(reviewGroupKey(doc("d1", { chatUuid: "chat-1" }))).toBe("chat-1");
    expect(reviewGroupKey(doc("d1", { code1c: "0001" }))).toBe("0001");
    expect(reviewGroupKey(doc("d1"))).toBe("document:d1");
  });
});

describe("groupReviewItems", () => {
  it("groups by candidate and sorts groups by fullName (ru), docs by title", () => {
    const ivanov = candidate({ id: "c1", fullName: "Иванов Иван" });
    const petrov = candidate({ id: "c2", fullName: "Петров Пётр" });
    const items = [
      doc("d3", { title: "СНИЛС", candidate: petrov }),
      doc("d1", { title: "СНИЛС", candidate: ivanov }),
      doc("d2", { title: "Паспорт", candidate: ivanov }),
      doc("d4", { chatUuid: "lonely-chat" }),
    ];
    const groups = groupReviewItems(items);
    expect(groups.map((g) => g.key)).toEqual(["c1", "c2", "lonely-chat"]);
    expect(groups[0]!.documents.map((d) => d.title)).toEqual(["Паспорт", "СНИЛС"]);
    expect(groups[0]!.documents).toHaveLength(2);
    expect(groups[2]!.candidate).toBeNull();
  });

  it("merges documents that share chatUuid/code1c fallbacks", () => {
    const items = [doc("d1", { code1c: "0007" }), doc("d2", { code1c: "0007" })];
    const groups = groupReviewItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("0007");
  });
});

describe("formatBirthDateRu", () => {
  it("formats YYYY-MM-DD as dd.MM.yyyy", () => {
    expect(formatBirthDateRu("1990-05-17")).toBe("17.05.1990");
    expect(formatBirthDateRu(null)).toBe("—");
    expect(formatBirthDateRu("garbage")).toBe("garbage");
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
    expect(formatCandidateObject("ТЦ Север", "PRJ1")).toBe("Объект: ТЦ Север (PRJ1)");
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
      q: "  Иван  ",
      documentTypeCode: "PASSPORT",
      citizenship: "ru",
      manager: "Петров",
      mentor: "Сидоров",
      hasMentor: "true",
      birthDateFrom: "1990-01-01",
      birthDateTo: "not-a-date",
      positionCode: "pos1",
      projectCode: "prj1",
      cursor: "abc",
    });
    expect(filters).toEqual({
      status: "RETURNED",
      q: "Иван",
      documentTypeCode: "PASSPORT",
      citizenship: "ru",
      manager: "Петров",
      mentor: "Сидоров",
      hasMentor: true,
      birthDateFrom: "1990-01-01",
      birthDateTo: undefined,
      positionCode: "pos1",
      projectCode: "prj1",
      cursor: "abc",
    });
  });

  it("falls back to IN_REVIEW and maps hasMentor=false", () => {
    const filters = parseReviewSearchParams({ status: "BOGUS", hasMentor: "false", q: "   " });
    expect(filters.status).toBe("IN_REVIEW");
    expect(filters.hasMentor).toBe(false);
    expect(filters.q).toBeUndefined();
    expect(hasActiveReviewFilters(filters)).toBe(true);
  });

  it("reports no active filters for a clean queue request", () => {
    expect(hasActiveReviewFilters(parseReviewSearchParams({}))).toBe(false);
    expect(
      hasActiveReviewFilters(parseReviewSearchParams({ status: "IN_REVIEW", cursor: "x" })),
    ).toBe(false);
  });
});
