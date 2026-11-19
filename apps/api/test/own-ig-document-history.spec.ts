import { describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
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

describe("own ERP history for an employee with a candidate card", () => {
  const candidateUid = "a6a59761-a585-439b-a59f-a754aa44bd8e";
  const personUid = "c0d8c035-288f-4242-b63b-7d7467cbdb63";

  function fixture() {
    const prisma = {
      igEmploymentState: { findUnique: vi.fn().mockResolvedValue(null) },
      lkEmployee: {
        findUnique: vi.fn().mockResolvedValue({
          uuid: personUid,
          sourcePresent: true,
          fullName: "Test Employee",
          birthday: new Date("2000-01-01"),
        }),
      },
      candidate: { findMany: vi.fn().mockResolvedValue([{ erpUid: candidateUid }]) },
    };
    const original = { bytes: Buffer.from("file"), mimeType: "application/pdf" };
    const erp = {
      identity: vi.fn().mockRejectedValue(
        new ConflictException("CURRENT_CANDIDATE_CONFIRMATION_REQUIRED"),
      ),
      card: vi.fn().mockResolvedValue({ erpUid: candidateUid, code1C: "worker", personUid }),
      request: vi.fn().mockResolvedValue({
        items: [{ id: "known-document", title: "Паспорт", originalAvailable: true }],
      }),
      original: vi.fn().mockResolvedValue(original),
    };
    return {
      erp, original,
      service: new OwnDocumentHistoryService(prisma as never, erp as never, {} as never),
    };
  }

  it("lists history and opens originals from a verified ERP candidate after a current-cycle conflict", async () => {
    const { service, erp, original } = fixture();
    expect(await service.list("worker")).toMatchObject({
      erpAvailable: true,
      items: [{ id: "known-document", source: "ERP", title: "Паспорт" }],
    });
    expect(erp.request).toHaveBeenCalledWith("person-documents", expect.anything(), { candidate: candidateUid }, undefined, expect.any(AbortSignal));
    expect(await service.erpFile("worker", "known-document")).toEqual(original);
    expect(erp.original).toHaveBeenCalledWith(candidateUid, "known-document");
    expect(erp.card).toHaveBeenCalledTimes(2);
  });

  it("denies the original if ERP ownership changed or the ID is absent from the employee's history", async () => {
    const { service, erp } = fixture();
    await expect(service.erpFile("worker", "another-document")).rejects.toThrow();
    erp.card.mockResolvedValueOnce({ erpUid: candidateUid, code1C: "worker", personUid: "other" });
    await expect(service.erpFile("worker", "known-document")).rejects.toThrow();
    expect(erp.original).not.toHaveBeenCalled();
  });
});
