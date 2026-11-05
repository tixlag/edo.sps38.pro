import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpirationRetryWorker } from "../src/expiration/expiration-retry.worker";

afterEach(() => vi.useRealTimers());

describe("expiration retry worker", () => {
  it("runs recovery on startup and each minute without overlapping calls", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const retry = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const worker = new ExpirationRetryWorker({ retryDueAlerts: retry } as never, { get: () => "true" } as never);
    worker.onModuleInit();
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
  });

  it("does not start when the notification worker is disabled", async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const worker = new ExpirationRetryWorker({ retryDueAlerts: retry } as never, { get: () => "false" } as never);
    worker.onModuleInit();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
