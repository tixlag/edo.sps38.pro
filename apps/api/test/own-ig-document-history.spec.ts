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
      lkEmployee: { findUnique: vi.fn().mockResolvedValue(null) },
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
          personUid: "c0d8c035-288f-4242-b63b-7d7467cbdb63",
          reviewGroup: "IG",
          recipientType: "person",
        }),
      request: vi
        .fn()
        .mockResolvedValue({
          items: [{ id: "allowed", originalAvailable: true }],
        }),
      employeeHistoryOriginal: vi.fn(),
    };
    const service = new OwnDocumentHistoryService(
      { lkEmployee: { findUnique: vi.fn().mockResolvedValue(null) } } as never,
      erp as never,
      {} as never,
    );
    await expect(service.erpFile("worker", "somebody-else")).rejects.toThrow();
    expect(erp.employeeHistoryOriginal).not.toHaveBeenCalled();
    erp.identity.mockResolvedValueOnce({
      code1C: "other",
      personUid: "c0d8c035-288f-4242-b63b-7d7467cbdb63",
      reviewGroup: "IG",
      recipientType: "person",
    });
    await expect(service.erpFile("worker", "allowed")).rejects.toThrow();
    expect(erp.employeeHistoryOriginal).not.toHaveBeenCalled();
  });
});

describe("ERP employee document history contract", () => {
  const personUid = "c0d8c035-288f-4242-b63b-7d7467cbdb63";
  it("reads the history with a verified person UUID without resolving an active hire", async () => {
    const prisma = {
      igEmploymentState: { findUnique: vi.fn().mockResolvedValue(null) },
      lkEmployee: { findUnique: vi.fn().mockResolvedValue({ uuid: personUid, sourcePresent: true }) },
    };
    const id = "person:known-document";
    const file = { bytes: Buffer.from("file"), mimeType: "application/pdf" };
    const erp = {
      identity: vi.fn(),
      request: vi.fn().mockResolvedValue({
        items: [{ id, title: "Паспорт", originalAvailable: true }],
      }),
      employeeHistoryOriginal: vi.fn().mockResolvedValue(file),
    };
    const service = new OwnDocumentHistoryService(prisma as never, erp as never, {} as never);
    expect(await service.list("worker")).toMatchObject({ erpAvailable: true, items: [{ id }] });
    expect(erp.request).toHaveBeenCalledWith(
      "employee-document-history", expect.anything(), { code1c: "worker", personUid },
    );
    await expect(service.erpFile("worker", "person:unknown")).rejects.toThrow();
    expect(erp.employeeHistoryOriginal).not.toHaveBeenCalled();
    expect(await service.erpFile("worker", id)).toEqual(file);
    expect(erp.employeeHistoryOriginal).toHaveBeenCalledWith("worker", personUid, id);
    expect(erp.identity).not.toHaveBeenCalled();
  });
});
