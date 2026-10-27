import { describe, expect, it } from "vitest";
import { KPI_META, parseDashboardSearch } from "./DashboardPage";

describe("Dashboard KPI transitions (KPI_META.to)", () => {
  it("queue leads to the /review document queue it counts", () => {
    expect(KPI_META.queue.to).toBe("/review");
  });

  it("in_review distinct-candidate metric has no ambiguous document-count transition", () => {
    expect(KPI_META.in_review.to).toBeUndefined();
  });

  it("rework leads to the /review queue (same document scope as the KPI), never to mine-only /history", () => {
    expect(KPI_META.rework.to).toBe("/review");
  });

  it("no KPI links to /history (a 20002 reviewer sees only own actions there, KPIs count every in-scope row)", () => {
    for (const [key, meta] of Object.entries(KPI_META)) {
      expect(meta.to, key).not.toBe("/history");
    }
  });
});

it("uses exact current statuses for operational queue transitions", () => {
  expect(KPI_META.rework.currentStatus).toBe("RETURNED");
  expect(KPI_META.queue.currentStatus).toBe("IN_REVIEW");
  expect(KPI_META.ocr_failed.currentStatus).toBe("OCR_FAILED");
  expect(KPI_META.approved.to).toBeUndefined();
});

it("preserves manager identity and department in URL filters", () => {
  expect(
    parseDashboardSearch({ reviewGroup: "IG", managerName: "Анна Иванова" }),
  ).toEqual({
    reviewGroup: "IG",
    managerName: "Анна Иванова",
    managerCode1c: undefined,
    managerUnassigned: undefined,
  });
  expect(
    parseDashboardSearch({ reviewGroup: "ALL", managerUnassigned: "true" })
      .managerUnassigned,
  ).toBe(true);
  expect(
    parseDashboardSearch({ reviewGroup: "foreign", managerCode1c: 123 }),
  ).toEqual({
    reviewGroup: undefined,
    managerName: undefined,
    managerCode1c: undefined,
    managerUnassigned: undefined,
  });
});
