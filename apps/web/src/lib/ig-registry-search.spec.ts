import { describe, expect, it } from "vitest";
import { parseIgRegistrySearch } from "./ig-registry-search";

describe("arrival registry URL", () => {
  it("retains filters, multiple open groups and their page cursors for document return", () => {
    expect(
      parseIgRegistrySearch({
        view: "arrivals",
        igArchive: "archive",
        igQ: " Алиев ",
        igDateFrom: "2026-11-01",
        igDateTo: "2026-11-30",
        igLocationUid: "loc-1",
        igDocumentStatus: "RETURNED",
        igRequirementsAction: "REVIEW",
        igNeedsAttention: "true",
        igGroups: JSON.stringify(["group-a", "group-b"]),
        igDates: JSON.stringify(["2026-11-10"]),
        igPages: JSON.stringify({ "group-a": "cursor-a" }),
        igCursor: "cursor-groups",
      }),
    ).toEqual({
      view: "arrivals",
      igArchive: "archive",
      igQ: "Алиев",
      igDateFrom: "2026-11-01",
      igDateTo: "2026-11-30",
      igLocationUid: "loc-1",
      igDocumentStatus: "RETURNED",
      igRequirementsAction: "REVIEW",
      igNeedsAttention: true,
      igGroups: JSON.stringify(["group-a", "group-b"]),
      igDates: JSON.stringify(["2026-11-10"]),
      igPages: JSON.stringify({ "group-a": "cursor-a" }),
      igCursor: "cursor-groups",
    });
  });
  it("preserves the selected historical participation without trusting extra fields", () => {
    expect(
      parseIgRegistrySearch({
        igParticipation: JSON.stringify({
          memberUid: "m1",
          date: "2026-01-01",
          arrivalDateTime: "2026-01-01T14:35:00",
          location: "Склад",
          status: "HISTORICAL",
          extra: "ignored",
        }),
      }),
    ).toEqual({
      igParticipation:
        '{"memberUid":"m1","date":"2026-01-01","arrivalDateTime":"2026-01-01T14:35:00","location":"Склад","status":"HISTORICAL"}',
    });
  });
  it("retains bounded page histories and the explicit all-dates choice", () => {
    expect(
      parseIgRegistrySearch({
        igPeriod: "all",
        igGroupStack: '["","cursor-1"]',
        igPageStacks: '{"group-a":["","person-1"]}',
      }),
    ).toEqual({
      igPeriod: "all",
      igGroupStack: '["","cursor-1"]',
      igPageStacks: '{"group-a":["","person-1"]}',
    });
  });
  it("rejects malformed or unsupported untrusted search values", () => {
    expect(
      parseIgRegistrySearch({
        view: "other",
        igArchive: "bad",
        igDocumentStatus: "bad",
        igNeedsAttention: "maybe",
        igGroups: "[",
        igPages: "[]",
        igDateFrom: "bad",
      }),
    ).toEqual({});
  });
});
