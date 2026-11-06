import { describe, expect, it, vi } from "vitest";
import {
  OwnDocumentHistoryService,
  safeHistoricalMime,
} from "../src/documents/own-document-history.service";

describe("own IG document history", () => {
  it("does not serve active historical content as HTML or SVG", () => {
    expect(safeHistoricalMime("text/html")).toBe("application/octet-stream");
    expect(safeHistoricalMime("image/svg+xml")).toBe(
      "application/octet-stream",
    );
    expect(safeHistoricalMime("application/pdf")).toBe("application/pdf");
  });
  it("keeps earlier EDO files visible when ERP history is unavailable", async () => {
    const prisma = {
      igEmploymentState: {
        findUnique: vi
          .fn()
          .mockResolvedValue({
            currentCandidateId: "new",
            currentCandidate: { personUid: "person" },
          }),
      },
      document: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            {
              id: "old-document",
              currentVersion: 1,
              status: "APPROVED",
              documentType: { title: "Паспорт" },
              versions: [
                {
                  version: 1,
                  files: [{ id: "page", filename: "passport.jpg" }],
                },
              ],
            },
          ]),
      },
    };
    const erp = { identity: vi.fn().mockRejectedValue(new Error("offline")) };
    const service = new OwnDocumentHistoryService(
      prisma as never,
      erp as never,
      {} as never,
    );
    const result = await service.list("worker");
    expect(result.erpAvailable).toBe(false);
    expect(result.items).toEqual([
      {
        source: "EDO",
        id: "old-document",
        title: "Паспорт",
        files: [{ id: "page", name: "passport.jpg" }],
      },
    ]);
  });
  it("does not return an EDO file belonging to another person", async () => {
    const prisma = {
      igEmploymentState: {
        findUnique: vi.fn().mockResolvedValue({ currentCandidateId: "new" }),
      },
      document: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const storage = { read: vi.fn() };
    const service = new OwnDocumentHistoryService(
      prisma as never,
      {} as never,
      storage as never,
    );
    await expect(
      service.edoFile("worker", "other-document", "page"),
    ).rejects.toThrow();
    expect(storage.read).not.toHaveBeenCalled();
  });
  it("requires ERP to confirm the employee identity and document membership before downloading", async () => {
    const erp = {
      identity: vi
        .fn()
        .mockResolvedValue({
          code1C: "worker",
          personUid: "person",
          reviewGroup: "IG",
          recipientType: "person",
        }),
      request: vi
        .fn()
        .mockResolvedValue({
          items: [{ id: "allowed", originalAvailable: true }],
        }),
      personOriginal: vi.fn(),
    };
    const service = new OwnDocumentHistoryService(
      {} as never,
      erp as never,
      {} as never,
    );
    await expect(service.erpFile("worker", "somebody-else")).rejects.toThrow();
    expect(erp.personOriginal).not.toHaveBeenCalled();
    erp.identity.mockResolvedValueOnce({
      code1C: "other",
      personUid: "person",
      reviewGroup: "IG",
      recipientType: "person",
    });
    await expect(service.erpFile("worker", "allowed")).rejects.toThrow();
    expect(erp.personOriginal).not.toHaveBeenCalled();
  });
});
