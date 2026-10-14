import { Logger } from "@nestjs/common";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DocumentEventsService } from "../src/documents/document-events.service";

describe("DocumentEventsService read failures", () => {
  let service: DocumentEventsService;
  const read = vi.fn();
  const warn = vi
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset();
    warn.mockClear();
    service = new DocumentEventsService(
      {} as never,
      { internalDocuments: read } as never,
      {} as never,
      {} as never,
    );
  });
  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });
  afterAll(() => warn.mockRestore());

  it("keeps the stream open during a read outage, sends heartbeats and recovers", async () => {
    read.mockRejectedValue(new Error("Database unavailable"));
    const next = vi.fn();
    const error = vi.fn();
    const complete = vi.fn();
    service.stream({ chat_uuid: "owner" }).subscribe({ next, error, complete });
    await vi.advanceTimersByTimeAsync(15000);
    expect(read).toHaveBeenCalledTimes(5); // 0, 1, 3, 7, 15 seconds
    expect(warn).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith({ type: "heartbeat", data: {} });
    expect(error).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();

    read.mockResolvedValue({ items: [] });
    await vi.advanceTimersByTimeAsync(16000);
    expect(next).toHaveBeenCalledWith({
      type: "documents",
      data: { items: [] },
    });
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(calls + 1);
  });

  it("still expires grants and releases polling after a failed read", async () => {
    read.mockRejectedValue(new Error("Database unavailable"));
    const complete = vi.fn();
    service
      .stream({ chat_uuid: "owner" }, undefined, new Date(Date.now() + 5000))
      .subscribe({ complete });
    await vi.advanceTimersByTimeAsync(5000);
    expect(complete).toHaveBeenCalledOnce();
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});
