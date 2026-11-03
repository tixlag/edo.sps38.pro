import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { IgGrantPoller } from "../src/documents/ig-grant-poller";

describe("adaptation grant polling", () => {
  it("loads previous documents before acknowledging an admitted person", async () => {
    const event = {
      id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      employeeCode1c: "worker",
      citizenship: "UZ",
      createdAt: "2026-11-03T00:00:00.000Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([event])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const history = { previous: vi.fn().mockResolvedValue({ items: [] }) };
      const poller = new IgGrantPoller(
        new ConfigService({
          EDO_ADAPTATION_EVENTS_URL: "https://surveys.example/events",
          EDO_ADAPTATION_SYNC_TOKEN: "secret",
        }),
        { applyGrant: vi.fn().mockResolvedValue("case") } as never,
        history as never,
      );
      await poller.sync();
      expect(history.previous).toHaveBeenCalledWith(
        "case",
        expect.objectContaining({ uuid: "system:adaptation" }),
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects an oversized event response without applying or acknowledging anything", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(["x".repeat(300_000)])));
    vi.stubGlobal("fetch", fetcher);
    try {
      const employment = { applyGrant: vi.fn() };
      const poller = new IgGrantPoller(
        new ConfigService({
          EDO_ADAPTATION_EVENTS_URL: "https://surveys.example/events",
          EDO_ADAPTATION_SYNC_TOKEN: "secret",
        }),
        employment as never,
      );
      await expect(poller.sync()).rejects.toThrow();
      expect(employment.applyGrant).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("advances past a full page of failed events and retries them in a later pass", async () => {
    const warning = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      employeeCode1c: `worker${i}`,
      citizenship: i === 99 ? "unknown" : "UZ",
      createdAt: "2026-11-03T00:00:00.000Z",
    }));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(items)))
      .mockResolvedValueOnce(new Response("[]"));
    vi.stubGlobal("fetch", fetcher);
    try {
      const employment = {
        applyGrant: vi.fn().mockRejectedValue(new Error("ERP unavailable")),
      };
      const poller = new IgGrantPoller(
        new ConfigService({
          EDO_ADAPTATION_EVENTS_URL: "https://surveys.example/events",
          EDO_ADAPTATION_SYNC_TOKEN: "secret",
        }),
        employment as never,
      );
      await poller.sync();
      await poller.sync();
      expect(String(fetcher.mock.calls[1][0])).toContain(
        `after=${items[99].id}`,
      );
    } finally {
      vi.unstubAllGlobals();
      warning.mockRestore();
    }
  });
  it("acknowledges only events successfully committed to EDO", async () => {
    const events = [
      {
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker1",
        citizenship: "UZ",
        createdAt: "2026-11-03T00:00:00.000Z",
      },
      {
        id: "ab2f1a81-1672-4ca3-8774-b5b22f0cf4e7",
        employeeCode1c: "worker2",
        citizenship: "UZ",
        createdAt: "2026-11-03T00:00:00.000Z",
      },
    ];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(events), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const employment = {
        applyGrant: vi
          .fn()
          .mockResolvedValueOnce("candidate")
          .mockRejectedValueOnce(new Error("ERP unavailable")),
      };
      const poller = new IgGrantPoller(
        new ConfigService({
          EDO_ADAPTATION_EVENTS_URL:
            "https://surveys.example/internal/edo/adaptation-grant-events",
          EDO_ADAPTATION_SYNC_TOKEN: "secret",
        }),
        employment as never,
      );
      await poller.sync();
      expect(employment.applyGrant).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
        ids: [events[0].id],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
