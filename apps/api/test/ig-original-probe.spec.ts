import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { OwnDocumentHistoryService } from "../src/documents/own-document-history.service";

const bytes = Buffer.from("synthetic original");
const hash = createHash("sha256").update(bytes).digest("hex");
describe("previous local original proof", () => {
  it("verifies the complete original against its saved hash and size", async () => {
    const storage = { openRead: vi.fn(async () => Readable.from([bytes])) };
    const service = new OwnDocumentHistoryService(
      {} as never,
      {} as never,
      storage as never,
    );
    expect(await service.probeOriginal("key", bytes.length, hash)).toBe(true);
    expect(
      await service.probeOriginal("key", bytes.length, "0".repeat(64)),
    ).toBe(false);
    expect(await service.probeOriginal("key", bytes.length - 1, hash)).toBe(
      false,
    );
    expect(await service.probeOriginal("key", bytes.length, null)).toBe(false);
  });
  it("does not treat a missing object as an available original", async () => {
    const service = new OwnDocumentHistoryService(
      {} as never,
      {} as never,
      {
        openRead: vi.fn(async () => {
          throw new Error("missing");
        }),
      } as never,
    );
    await expect(
      service.probeOriginal("missing", bytes.length, hash),
    ).rejects.toThrow("missing");
  });
});
