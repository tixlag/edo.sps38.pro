import { describe, expect, it, vi } from "vitest";
import { normalizeErpCandidate } from "../src/documents/erp-candidate.client";
import { CandidateDocumentsService } from "../src/documents/candidate-documents.service";
import { DocumentCatalogService } from "../src/documents/document-catalog.service";
import {
  applicable,
  candidateSnapshotSchema,
} from "../src/documents/document-contract";
import { snapshotUpdateInput } from "../src/documents/candidate-profile";

describe("candidate sex and document exceptions", () => {
  it("preserves candidate fields from the 1C envelope", () => {
    const result = normalizeErpCandidate({
      candidate: {
        uuid: null,
        citizenship: "RU",
        sex: " Женский ",
        photoPath: "photo.jpg",
      },
      position: { code: "P" },
      master: { name: "Мастер", code: "M" },
      supervisor: { name: "Руководитель", code: "S" },
    });
    expect(result).toMatchObject({
      sex: "female",
      sexKnown: true,
      photoPath: "photo.jpg",
      master: { name: "Мастер", code: "M" },
      supervisor: { name: "Руководитель", code: "S" },
    });
    const snapshot = candidateSnapshotSchema.parse(result);
    expect(snapshot).toMatchObject({
      sex: "female",
      sexKnown: true,
      masterName: "Мастер",
      supervisorCode1c: "S",
    });
    expect(candidateSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("excludes military only for a known female candidate", () => {
    const military = {
      code: "MILITARY",
      allRu: true,
      allForeign: false,
      positions: [],
    };
    expect(applicable(military, "P", "ru", "female")).toBe(false);
    expect(applicable(military, "P", "ru", "male")).toBe(true);
    expect(applicable(military, "P", "ru", null)).toBe(true);
    expect(
      applicable({ ...military, code: "PASSPORT" }, "P", "ru", "female"),
    ).toBe(true);
  });
  it("keeps existing values when 1C sends empty fields and records unknown sex", () => {
    const update = snapshotUpdateInput(
      candidateSnapshotSchema.parse({
        sexKnown: false,
        photoPath: "",
        master: { name: "", code: "" },
      }),
    );
    expect(update).toMatchObject({ sexKnown: false });
    expect(update).not.toHaveProperty("photoPath");
    expect(update).not.toHaveProperty("masterName");
    expect(update).not.toHaveProperty("masterCode1c");
  });

  it("does not silently truncate new profile fields from 1C", () => {
    const candidate = {
      candidate: { citizenship: "RU", photoPath: "x".repeat(2049) },
      position: { code: "P" },
    };
    expect(() => normalizeErpCandidate(candidate)).toThrow();
  });

  it("preserves master and supervisor when an older response supplies strings", () => {
    const card = normalizeErpCandidate({
      candidate: { citizenship: "RU" },
      position: { code: "P" },
      master: " Мастер ",
      supervisor: " Руководитель ",
    });
    expect(card).toMatchObject({
      master: { name: "Мастер" },
      supervisor: { name: "Руководитель" },
    });
  });

  it.each(["", "неизвестно", null, undefined])(
    "treats unrecognized sex %s as unknown",
    (sex) => {
      const card = normalizeErpCandidate({
        candidate: { citizenship: "RU", sex },
        position: { code: "P" },
      });
      expect(card).toMatchObject({ sexKnown: false });
      expect(card.sex).toBeUndefined();
    },
  );

  it("filters the 1C catalog for the candidate forms while keeping voluntary applicability", async () => {
    const military = {
      code: "MILITARY",
      title: "Военный билет",
      erpUid: "id-m",
      catalogSyncedAt: new Date(),
      allRu: true,
      allForeign: false,
      positions: [],
      definitions: [],
    };
    const passport = {
      ...military,
      code: "PASSPORT",
      title: "Паспорт",
      erpUid: "id-p",
    };
    const db = {
      documentType: {
        findFirst: vi.fn().mockResolvedValue({ catalogSyncedAt: new Date() }),
        findMany: vi.fn().mockResolvedValue([military, passport]),
      },
    };
    const catalog = new DocumentCatalogService(
      db as never,
      {} as never,
      {} as never,
    );
    const contexts = {
      context: vi.fn().mockResolvedValue({
        positionCode1c: "P",
        citizenship: "ru",
        candidateSnapshot: { sex: "female", sexKnown: true },
      }),
    };
    const service = new CandidateDocumentsService(
      contexts as never,
      {} as never,
      catalog,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(
      (await service.types("chat")).items.map((item) => item.code),
    ).toEqual(["PASSPORT"]);
    expect(applicable(military, "P", "ru")).toBe(true);
  });

  it("uses the citizenship default for documents without overwriting a saved nationality", () => {
    const card = normalizeErpCandidate({
      candidate: { citizenship: "" },
      position: { code: "P" },
    });
    expect(card.citizenship).toBe("ru");
    expect(
      snapshotUpdateInput(candidateSnapshotSchema.parse(card)),
    ).not.toHaveProperty("citizenship");
    expect(
      snapshotUpdateInput(
        candidateSnapshotSchema.parse(normalizeErpCandidate(card)),
      ),
    ).not.toHaveProperty("citizenship");
  });
});
