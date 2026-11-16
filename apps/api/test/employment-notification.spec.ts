import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmploymentNotificationService } from "../src/documents/employment-notification.service";

const confirmed = {
  fullName: "Иван Петров",
  employmentConfirmed: true,
  employmentConfirmationId:
    "hire:123e4567-e89b-12d3-a456-426614174000:20261116",
  employmentNotificationRecipientCodes1c: [
    "manager",
    "responsible",
    "manager",
    "additional",
  ],
};
function fixture() {
  const records: Array<{
    id: string;
    candidateId: string;
    confirmationKey: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    leaseUntil: Date | null;
  }> = [];
  const ledger = {
    upsert: vi.fn(async ({ where, create }) => {
      let record = records.find(
        (r) =>
          r.candidateId === where.candidateId_confirmationKey.candidateId &&
          r.confirmationKey ===
            where.candidateId_confirmationKey.confirmationKey,
      );
      if (!record) {
        record = {
          ...create,
          id: `op-${records.length}`,
          status: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
          leaseUntil: null,
        };
        records.push(record);
      }
      return { ...record };
    }),
    findUniqueOrThrow: vi.fn(async ({ where }) => ({
      ...records.find((r) => r.id === where.id),
    })),
    findMany: vi.fn(async () =>
      records.filter(
        (r) => r.status !== "SENT" && r.nextAttemptAt <= new Date(),
      ),
    ),
    updateMany: vi.fn(async ({ where, data }) => {
      const record = records.find((r) => r.id === where.id);
      if (!record) return { count: 0 };
      if (
        where.OR &&
        (record.status === "SENT" ||
          (record.status === "SENDING" && record.leaseUntil > new Date()) ||
          record.nextAttemptAt > new Date())
      )
        return { count: 0 };
      if (
        where.status &&
        (record.status !== where.status ||
          record.leaseUntil?.getTime() !== where.leaseUntil?.getTime())
      )
        return { count: 0 };
      Object.assign(record, data, {
        attempts: data.attempts
          ? record.attempts + data.attempts.increment
          : record.attempts,
      });
      return { count: 1 };
    }),
  };
  const lk = {
    sendNotification: vi.fn(async () => ({
      success: true,
      complete: true,
      outcome: "complete",
    })),
  };
  const service = new EmploymentNotificationService(
    { candidateEmploymentNotification: ledger } as never,
    lk as never,
    { get: () => "test" } as never,
  );
  return { service, lk, ledger, records };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("confirmed employment notifications", () => {
  it("never infers employment from document completion or an absent ERP hire identity", async () => {
    const { service, ledger, lk } = fixture();
    expect(
      await service.observe("candidate", {
        ...confirmed,
        employmentConfirmed: false,
      }),
    ).toBe(false);
    await service.observe("candidate", {
      ...confirmed,
      employmentConfirmationId: null,
    });
    expect(ledger.upsert).not.toHaveBeenCalled();
    expect(lk.sendNotification).not.toHaveBeenCalled();
  });
  it("skips candidates without explicitly assigned recipients", async () => {
    const { service, ledger } = fixture();
    expect(
      await service.observe("candidate", {
        ...confirmed,
        employmentNotificationRecipientCodes1c: [],
      }),
    ).toBe(false);
    expect(ledger.upsert).not.toHaveBeenCalled();
  });
  it("sends only assigned codes and suppresses repeated refreshes after success", async () => {
    const { service, lk, records } = fixture();
    expect(await service.observe("candidate", confirmed)).toBe(true);
    expect(await service.observe("candidate", confirmed)).toBe(true);
    await service.retry();
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(lk.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientCodes1c: ["additional", "manager", "responsible"],
        idempotencyKey: "employment-confirmed:op-0",
        targetUrl: "/review/candidates/candidate",
      }),
    );
    expect(records[0].status).toBe("SENT");
  });
  it("does not send concurrently when two refreshes race", async () => {
    const { service, lk } = fixture();
    await Promise.all([
      service.observe("candidate", confirmed),
      service.observe("candidate", confirmed),
    ]);
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
  });
  it("retries an uncertain or partial LK outcome with the same idempotency key", async () => {
    const { service, lk, records } = fixture();
    lk.sendNotification.mockResolvedValueOnce({
      success: false,
      complete: false,
      outcome: "partial",
    });
    expect(await service.observe("candidate", confirmed)).toBe(true);
    expect(records[0].status).toBe("FAILED");
    await service.retry();
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_001);
    await service.retry();
    expect(lk.sendNotification).toHaveBeenCalledTimes(2);
    expect(lk.sendNotification.mock.calls[0][0].idempotencyKey).toBe(
      lk.sendNotification.mock.calls[1][0].idempotencyKey,
    );
    expect(records[0].status).toBe("SENT");
  });
  it("creates a new notification for a later real hire event on the permanent card", async () => {
    const { service, lk, records } = fixture();
    await service.observe("candidate", confirmed);
    await service.observe("candidate", {
      ...confirmed,
      employmentConfirmationId:
        "hire:123e4567-e89b-12d3-a456-426614174000:20271116",
    });
    expect(records).toHaveLength(2);
    expect(lk.sendNotification).toHaveBeenCalledTimes(2);
  });
  it("recovers an expired worker lease after restart", async () => {
    const { service, records, lk } = fixture();
    await service.observe("candidate", confirmed);
    records[0].status = "SENDING";
    records[0].leaseUntil = new Date(Date.now() - 1);
    records[0].nextAttemptAt = new Date(Date.now() - 1);
    lk.sendNotification.mockClear();
    await service.retry();
    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(records[0].status).toBe("SENT");
  });
});
