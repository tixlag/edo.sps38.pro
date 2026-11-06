import { describe, expect, it, vi } from "vitest";
import { ContractsService } from "../src/contracts/contracts.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const actor = { uuid: "hr", code1c: null, accessRules: { "20003": [], "20008": [] } } as AuthPrincipal;

describe("pending contract notifications", () => {
  it("counts every unread pending notification and retrieves the requested page", async () => {
    const notifications = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(155),
    };
    const service = new ContractsService({ signingContractNotification: notifications } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const result = await service.notifications(actor, { limit: 30, offset: 120 });
    expect(result).toEqual({ items: [], total: 155 });
    expect(notifications.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ recipientId: "hr", kind: { not: "sent" }, deliveredAt: null, readAt: null }),
      take: 30, skip: 120,
    }));
    expect(notifications.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ recipientId: "hr", kind: { not: "sent" }, deliveredAt: null, readAt: null }),
    }));
  });

  it("marks all accessible unread rows, including rows delivered during read-all", async () => {
    const notifications = { updateMany: vi.fn().mockResolvedValue({ count: 155 }) };
    const service = new ContractsService({ signingContractNotification: notifications } as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(service.readAllNotifications(actor)).resolves.toEqual({ updated: 155 });
    expect(notifications.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { recipientId: "hr", kind: { not: "sent" }, readAt: null, contract: { candidate: {} } },
      data: { readAt: expect.any(Date) },
    }));
  });
});
