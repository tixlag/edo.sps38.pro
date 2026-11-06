import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { DocumentDeliveryService } from "../src/documents/document-delivery.service";

describe("retired ERP v1 deliveries", () => {
  it("rejects explicit retries before starting an attempt or contacting ERP", async () => {
    const row = {
      id: "delivery",
      transport: "base64-v1",
      status: "REQUIRES_MANUAL",
      version: { documentId: "doc", fields: [] },
    };
    const tx = {
      erpDocumentDelivery: {
        findUniqueOrThrow: vi.fn(async () => row),
        updateMany: vi.fn(),
      },
      erpDocumentAttempt: { create: vi.fn() },
    };
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };
    const service = new DocumentDeliveryService(
      prisma as never,
      {} as never,
      new ConfigService(),
      {} as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    await expect(service.send("delivery")).rejects.toThrow(
      "Legacy ERP delivery requires manual reconciliation",
    );
    expect(tx.erpDocumentDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.erpDocumentAttempt.create).not.toHaveBeenCalled();
  });
  it("parks pending v1 records with an audit entry and only sends pending v2", async () => {
    const row = { id: "legacy", version: { documentId: "doc", version: 1 } };
    const tx = {
      erpDocumentDelivery: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const findMany = vi.fn(async (args: { where: { transport?: string } }) =>
      args.where.transport === "base64-v1" ? [row] : [],
    );
    const prisma = {
      erpDocumentDelivery: { findMany },
      documentSubmission: { findMany: vi.fn(async () => []) },
      documentVersion: { findMany: vi.fn(async () => []) },
      documentStreamGrant: { deleteMany: vi.fn() },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };
    const audit = { logInTransaction: vi.fn() };
    const service = new DocumentDeliveryService(
      prisma as never,
      {} as never,
      new ConfigService(),
      audit as never,
      undefined as never,
      undefined as never,
      {} as never,
      {} as never,
      { cleanupCache: vi.fn() } as never,
    );
    await service.tick();
    expect(tx.erpDocumentDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: "legacy", status: "PENDING", transport: "base64-v1" },
      data: {
        status: "REQUIRES_MANUAL",
        nextAttemptAt: null,
        errorCode: "ERP_V1_RETIRED",
      },
    });
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        after: expect.objectContaining({ reason: "ERP_V1_RETIRED" }),
      }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "PENDING",
          transport: "multipart-v2",
        }),
        take: 5,
      }),
    );
  });
});
