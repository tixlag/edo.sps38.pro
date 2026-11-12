import { describe, expect, it } from "vitest";
import { AXIOS_INSTANCE } from "@edo/api-client";
import { filterValues, parseFilterValues } from "./filter-values";
import { parseReviewSearchParams } from "./review-groups";
import { parseDashboardSearch } from "../pages/DashboardPage";
import { parseIgRegistrySearch } from "./ig-registry-search";

describe("filter state and transport", () => {
  it("uses repeated query keys without brackets and preserves Unicode and manager prefixes", () => {
    const uri = AXIOS_INSTANCE.getUri({
      url: "/",
      params: {
        statusIds: ["Подбор", "Отказ"],
        managerKeys: ["id:M1", "name:Иванов Иван"],
      },
    });
    const query = new URL(uri).searchParams;
    expect(query.getAll("statusIds")).toEqual(["Подбор", "Отказ"]);
    expect(query.getAll("managerKeys")).toEqual(["id:M1", "name:Иванов Иван"]);
    expect(query.has("statusIds[]")).toBe(false);
  });
  it("preserves explicit empty selections and legacy links, bounds and deduplicates values", () => {
    expect(filterValues({ statusId: "old" }, "statusIds", "statusId")).toEqual([
      "old",
    ]);
    expect(
      filterValues({ statusIds: [], statusId: "old" }, "statusIds", "statusId"),
    ).toEqual([]);
    expect(parseFilterValues(["A", " A ", "", "B"])).toEqual(["A", "B"]);
    expect(parseFilterValues(Array(101).fill("A"))).toBeUndefined();
    expect(parseFilterValues([{ value: "A" }])).toBeUndefined();
  });
  it("retains arrays through review, dashboard and IG navigation parsers", () => {
    expect(
      parseReviewSearchParams({
        candidateIds: ["c1", "c2"],
        managerKeys: [],
        hasMentorValues: ["true", "false"],
      }),
    ).toMatchObject({
      candidateIds: ["c1", "c2"],
      managerKeys: [],
      hasMentorValues: ["true", "false"],
    });
    expect(
      parseDashboardSearch({
        reviewGroups: ["RU", "IG"],
        managerKeys: ["code:M1", "unassigned"],
      }),
    ).toMatchObject({
      reviewGroups: ["RU", "IG"],
      managerKeys: ["code:M1", "unassigned"],
    });
    expect(
      parseIgRegistrySearch({
        igLocationUids: ["a", "b"],
        igRequirementsActions: ["REVIEW", "MISSING"],
      }),
    ).toMatchObject({
      igLocationUids: ["a", "b"],
      igRequirementsActions: ["REVIEW", "MISSING"],
    });
  });
});
