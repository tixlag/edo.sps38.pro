import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractNotificationDeliveryService } from "../src/contracts/contract-notification-delivery.service";

const notification = {
  id: "notice-1",
  contractId: "contract-1",
  recipientId: "hr-uuid",
  message: "Сотрудник подписал договор",
  deliveryAttempts: 0,
  deliveredAt: null,
  readAt: null,
  lkBroadcastUuid: null,
};

function setup(employees: Array<{ code1c: string }>, success = true) {
  const rows = {
    findMany: vi.fn().mockResolvedValue([notification]),
    findUnique: vi.fn().mockResolvedValue(notification),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = { signingContractNotification: rows, lkEmployee: { findMany: vi.fn().mockResolvedValue(employees) } };
  const lk = { sendNotification: vi.fn().mockResolvedValue({ success, broadcastUuid: "lk-broadcast" }), markRead: vi.fn().mockResolvedValue({ updated: 1 }) };
  return { rows, prisma, lk, service: new ContractNotificationDeliveryService(prisma as never, lk as never, { get: () => "false" } as never) };
}

describe("contract notification delivery", () => {
  afterEach(() => vi.useRealTimers());

  it("processes an event wake without waiting for the recovery interval", async () => {
    vi.useFakeTimers();
    const { prisma, lk } = setup([{ code1c: "HR1" }]);
    const worker = new ContractNotificationDeliveryService(prisma as never, lk as never, { get: () => "true" } as never);
    worker.wake("contract-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(prisma.signingContractNotification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ contractId: { in: ["contract-1"] } }),
    }));
    worker.onModuleDestroy();
  });

  it("recovers after a lost wake on startup and periodically without looping on database errors", async () => {
    vi.useFakeTimers();
    const { prisma, lk, rows } = setup([{ code1c: "HR1" }]);
    rows.findMany.mockRejectedValueOnce(new Error("database offline"));
    const worker = new ContractNotificationDeliveryService(prisma as never, lk as never, { get: () => "true" } as never);
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(1);
    expect(rows.findMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_998);
    expect(rows.findMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(rows.findMany).toHaveBeenCalledTimes(2);
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    worker.onModuleDestroy();
  });

  it("recovers rows left behind when a new wake interrupts a targeted batch", async () => {
    vi.useFakeTimers();
    const { prisma, lk, rows } = setup([{ code1c: "HR1" }]);
    const worker = new ContractNotificationDeliveryService(prisma as never, lk as never, { get: () => "true" } as never);
    rows.findMany.mockResolvedValueOnce([notification, { ...notification, id: "notice-2" }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    lk.sendNotification.mockImplementationOnce(async () => {
      worker.wake("new-contract");
      return { success: true, broadcastUuid: "lk-broadcast" };
    });
    worker.wake("contract-1");
    await vi.advanceTimersByTimeAsync(10);
    expect(rows.findMany).toHaveBeenCalledTimes(3);
    expect(rows.findMany.mock.calls[2][0].where).not.toHaveProperty("contractId");
    worker.onModuleDestroy();
  });

  it("does not start polling while the worker is disabled", () => {
    const { service } = setup([]);
    const timer = vi.spyOn(globalThis, "setInterval");
    try {
      service.onModuleInit();
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
  it("delivers to the matching LK employee with a stable idempotency key", async () => {
    const { service, lk, rows } = setup([{ code1c: "HR1" }]);
    await service.tick();
    expect(lk.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientCodes1c: ["HR1"],
      idempotencyKey: "signing-contract-notification:notice-1",
      targetUrl: "/signing?contractId=contract-1",
    }));
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveredAt: expect.any(Date), deliveryRetryAt: null }),
    }));
  });

  it("delivers a signing invitation directly to the frozen employee code", async () => {
    const { service, lk, prisma, rows } = setup([]);
    rows.findUnique.mockResolvedValue({ ...notification, kind: "sent", recipientId: "EMP-1", message: "Вам направлен договор", contract: { status: "WAITING_EMPLOYEE" } });
    await service.tick();
    expect(prisma.lkEmployee.findMany).not.toHaveBeenCalled();
    expect(lk.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientCodes1c: ["EMP-1"],
      title: "Вам направлен договор",
      targetUrl: "/my-documents?contractId=contract-1",
      idempotencyKey: "signing-contract-notification:notice-1",
    }));
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveredAt: expect.any(Date), lkBroadcastUuid: "lk-broadcast" }),
    }));
  });

  it("retries a failed employee invitation with the same key", async () => {
    const { service, lk, rows } = setup([], false);
    rows.findUnique.mockResolvedValue({ ...notification, kind: "sent", recipientId: "EMP-1", contract: { status: "WAITING_EMPLOYEE" } });
    await service.tick();
    expect(lk.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientCodes1c: ["EMP-1"],
      idempotencyKey: "signing-contract-notification:notice-1",
    }));
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryRetryAt: expect.any(Date) }),
    }));
  });

  it.each(["COMPLETED", "DECLINED"])("cancels an unsent invitation after contract becomes %s", async (status) => {
    const { service, lk, rows } = setup([]);
    rows.findUnique.mockResolvedValue({ ...notification, kind: "sent", recipientId: "EMP-1", contract: { status } });
    await service.tick();
    expect(lk.sendNotification).not.toHaveBeenCalled();
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "notice-1", deliveredAt: null }),
      data: expect.objectContaining({ deliveryCancelledAt: expect.any(Date), deliveryRetryAt: null, deliveryLeaseToken: null }),
    }));
    expect(rows.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deliveryCancelledAt: null }) }));
  });

  it("retries without sending when the recipient UUID is ambiguous", async () => {
    const { service, lk, rows } = setup([{ code1c: "HR1" }, { code1c: "HR2" }]);
    await service.tick();
    expect(lk.sendNotification).not.toHaveBeenCalled();
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryRetryAt: expect.any(Date) }),
    }));
    expect(rows.updateMany.mock.lastCall?.[0].data).not.toHaveProperty("deliveredAt");
  });

  it("retains failed deliveries for retry", async () => {
    const { service, rows } = setup([{ code1c: "HR1" }], false);
    await service.tick();
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryRetryAt: expect.any(Date) }),
    }));
    expect(rows.updateMany.mock.lastCall?.[0].data).not.toHaveProperty("deliveredAt");
  });

  it("synchronizes a local read that raced with delivery", async () => {
    const { service, rows, lk } = setup([{ code1c: "HR1" }]);
    rows.findUnique.mockResolvedValue({ ...notification, deliveredAt: new Date(), readAt: new Date(), lkBroadcastUuid: "lk-broadcast" });
    await service.tick();
    expect(lk.markRead).toHaveBeenCalledWith("hr-uuid", { uuids: ["lk-broadcast"] });
    expect(lk.sendNotification).not.toHaveBeenCalled();
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lkReadSyncedAt: expect.any(Date), deliveryRetryAt: null }),
    }));
  });

  it("recovers a possibly accepted send even if read locally after a crash", async () => {
    const { service, rows, lk } = setup([{ code1c: "HR1" }]);
    rows.findUnique.mockResolvedValue({ ...notification, readAt: new Date(), deliveryAttempts: 1 });
    await service.tick();
    expect(lk.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "signing-contract-notification:notice-1" }));
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lkBroadcastUuid: "lk-broadcast", deliveredAt: expect.any(Date) }),
    }));
  });

  it("retries synchronization if LK read marking fails", async () => {
    const { service, rows, lk } = setup([{ code1c: "HR1" }]);
    rows.findUnique.mockResolvedValue({ ...notification, deliveredAt: new Date(), readAt: new Date(), lkBroadcastUuid: "lk-broadcast" });
    lk.markRead.mockRejectedValue(new Error("offline"));
    await service.tick();
    expect(rows.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliveryRetryAt: expect.any(Date) }),
    }));
  });
});
