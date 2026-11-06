import { describe, expect, it, vi } from "vitest";
import { igUploadOwner } from "../src/documents/ig-upload-owner";

describe("IG upload owner", () => {
  it("uses the current employment cycle instead of the legacy employee card", async () => {
    const current = {
      id: "new-cycle",
      code1c: "worker",
      citizenship: "uz",
      chatUuid: null,
    };
    const tx = {
      $queryRaw: vi.fn(),
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({
            currentCandidate: current,
            currentCandidateId: current.id,
          }),
        update: vi.fn(),
      },
      candidate: { create: vi.fn() },
    };
    await expect(igUploadOwner(tx as never, "worker", "uz")).resolves.toEqual(
      current,
    );
    expect(tx.candidate.create).not.toHaveBeenCalled();
  });
  it("creates a separate cycle on the first upload", async () => {
    const current = {
      id: "legacy",
      code1c: "worker",
      citizenship: "uz",
      chatUuid: null,
    };
    const tx = {
      $queryRaw: vi.fn(),
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ currentCandidate: null }),
        update: vi.fn(),
      },
      candidate: { create: vi.fn().mockResolvedValue(current) },
    };
    await expect(igUploadOwner(tx as never, "worker", "uz")).resolves.toEqual(
      current,
    );
    expect(tx.igEmploymentState.update).toHaveBeenCalledWith({
      where: { code1c: "worker" },
      data: { currentCandidateId: "legacy" },
    });
  });
});
