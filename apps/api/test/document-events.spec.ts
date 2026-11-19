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
import { EdoAccessRule } from "../src/auth/edo-access-rule";

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

  it("keeps a long-lived JWT stream open and re-arms its bounded expiry timer", async () => {
    read.mockResolvedValue({ items: [] });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const complete = vi.fn();
    const expires = new Date(Date.now() + 6_000_000_000);
    try {
      service
        .stream({ chat_uuid: "owner" }, undefined, expires)
        .subscribe({ complete });
      expect(timeout.mock.calls[0][1]).toBe(2 ** 31 - 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(complete).not.toHaveBeenCalled();
      // Simulate the first maximum-duration wait ending without running
      // millions of unrelated polling ticks in fake time.
      clearTimeout(timeout.mock.results[0].value);
      vi.setSystemTime(expires.getTime() - 2000);
      (timeout.mock.calls[0][0] as () => void)();
      expect(timeout.mock.calls[1][1]).toBe(2000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(complete).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("DocumentEventsService ru-enrichment events", () => {
  let service: DocumentEventsService;
  let notificationsHandler: ((event: any) => void) | undefined;
  const prisma = {
    candidate: {
      findMany: vi.fn(),
    },
  };
  const reads = {
    documents: vi.fn().mockResolvedValue({ items: [] }),
    internalDocuments: vi.fn().mockResolvedValue({ items: [] }),
  };
  const access = {
    documentWhere: vi.fn().mockReturnValue({}),
    candidateWhere: vi.fn().mockReturnValue({}),
  };
  const notifications = {
    subscribe: vi.fn((handler) => {
      notificationsHandler = handler;
      return vi.fn();
    }),
  };

  beforeEach(() => {
    notificationsHandler = undefined;
    vi.clearAllMocks();
    service = new DocumentEventsService(
      prisma as never,
      reads as never,
      access as never,
      { get: () => "https://edo.sps38.pro" } as never,
      notifications as never,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it("delivers ru-enrichment to reviewer with RU permissions and filters candidates", async () => {
    const ruPrincipal = {
      uuid: "ru-user",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_RU]: [] },
    };
    const nextRu = vi.fn();
    service.stream(undefined, ruPrincipal as never).subscribe({ next: nextRu });

    // Only "c-1" is allowed in candidateWhere
    prisma.candidate.findMany.mockResolvedValue([{ id: "c-1" }]);

    notificationsHandler?.({
      items: [
        { candidateId: "c-1", status: "READY", retryAt: null },
        { candidateId: "c-2", status: "RETRY", retryAt: "2026-11-18T15:00:00.000Z" },
      ],
    });

    await Promise.resolve();

    expect(prisma.candidate.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { id: { in: ["c-1", "c-2"] } },
          {},
          expect.anything(),
        ],
      },
      select: { id: true },
    });

    expect(nextRu).toHaveBeenCalledWith({
      type: "ru-enrichment",
      data: {
        items: [{ candidateId: "c-1", status: "READY", retryAt: null }],
      },
    });
  });

  it("does not deliver ru-enrichment to principal without RU review rule", async () => {
    const igPrincipal = {
      uuid: "ig-user",
      accessRules: { [EdoAccessRule.DOCUMENT_REVIEW_IG]: [] },
    };
    const nextIg = vi.fn();
    service.stream(undefined, igPrincipal as never).subscribe({ next: nextIg });

    notificationsHandler?.({
      items: [{ candidateId: "c-1", status: "READY", retryAt: null }],
    });

    await Promise.resolve();

    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
    expect(nextIg).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ru-enrichment" }));
  });

  it("does not deliver ru-enrichment to owner-scoped stream", async () => {
    const nextOwner = vi.fn();
    service.stream({ chat_uuid: "owner-1" }).subscribe({ next: nextOwner });

    notificationsHandler?.({
      items: [{ candidateId: "c-1", status: "READY", retryAt: null }],
    });

    await Promise.resolve();

    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
    expect(nextOwner).not.toHaveBeenCalledWith(expect.objectContaining({ type: "ru-enrichment" }));
  });
});

it("keeps review SSE connected in events mode without reading all documents", async () => {
  vi.useFakeTimers();
  const snapshots = vi.fn().mockResolvedValue({ items: [] });
  const scoped = vi.fn().mockResolvedValue({ items: [] });
  const service = new DocumentEventsService(
    {} as never, { documents: snapshots, internalDocuments: scoped } as never,
    {} as never, { get: () => "events" } as never,
  );
  try {
    const next = vi.fn();
    service.stream(undefined, { uuid: "reviewer", accessRules: {} } as never).subscribe({ next });
    service.stream({ candidateId: "person" }).subscribe();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(snapshots).not.toHaveBeenCalled();
    expect(scoped).toHaveBeenCalledTimes(16);
    expect(next).toHaveBeenCalledWith({ type: "heartbeat", data: {} });
  } finally {
    service.onModuleDestroy();
    vi.useRealTimers();
  }
});
