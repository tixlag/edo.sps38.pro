import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { LkNotificationService, type SendLkNotificationInput } from "../src/lk/lk-notification.service";

describe("LkNotificationService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends EDO links with the public EDO origin for LK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        broadcastUuid: "broadcast-1",
        complete: true,
        outcome: "complete",
        resolvedCodes1c: ["HR1"],
        unresolvedCodes1c: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LkNotificationService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test",
        EDO_PUBLIC_WEB_URL: "https://edo.example",
      }),
    );

    const result = await service.sendNotification({
      recipientCodes1c: ["HR1"],
      title: "title",
      content: "content",
      targetUrl: "/signing?contractId=1",
      idempotencyKey: "idem-key-1",
    });

    expect(result.success).toBe(true);
    expect(result.broadcastUuid).toBe("broadcast-1");
    expect(result.complete).toBe(true);
    expect(result.outcome).toBe("complete");

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.targetUrl).toBe("https://edo.example/signing?contractId=1");
    expect(sentBody.idempotencyKey).toBe("idem-key-1");
    expect(sentBody.recipientCodes1c).toEqual(["HR1"]);
    // Must NOT send fingerprint
    expect(sentBody.fingerprint).toBeUndefined();
  });

  it("does not send a relative EDO target without a public web origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new LkNotificationService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test",
      }),
    );
    expect(
      (
        await service.sendNotification({
          recipientCodes1c: ["HR1"],
          title: "t",
          content: "c",
          targetUrl: "/review",
        })
      ).success,
    ).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats outcome === 'partial' on 201 as incomplete (success: false)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        broadcastUuid: "broadcast-partial",
        complete: false,
        outcome: "partial",
        resolvedCodes1c: ["HR1"],
        unresolvedCodes1c: ["HR2"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LkNotificationService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test",
        EDO_PUBLIC_WEB_URL: "https://edo.example",
      }),
    );

    const result = await service.sendNotification({
      recipientCodes1c: ["HR1", "HR2"],
      title: "t",
      content: "c",
    });

    expect(result.success).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.outcome).toBe("partial");
    expect(result.broadcastUuid).toBe("broadcast-partial");
    expect(result.resolvedCodes1c).toEqual(["HR1"]);
    expect(result.unresolvedCodes1c).toEqual(["HR2"]);
  });

  it("handles 409 RECIPIENT_RESOLUTION_INCOMPLETE response from LK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        code: "RECIPIENT_RESOLUTION_INCOMPLETE",
        complete: false,
        outcome: "partial",
        resolvedCodes1c: ["HR1"],
        unresolvedCodes1c: ["HR2"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LkNotificationService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test",
      }),
    );

    const result = await service.sendNotification({
      recipientCodes1c: ["HR1", "HR2"],
      title: "title",
      content: "content",
      idempotencyKey: "idem-key-409",
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe("RECIPIENT_RESOLUTION_INCOMPLETE");
    expect(result.complete).toBe(false);
    expect(result.outcome).toBe("partial");
    expect(result.resolvedCodes1c).toEqual(["HR1"]);
    expect(result.unresolvedCodes1c).toEqual(["HR2"]);
  });

  it("filters out any fingerprint field from the request payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, broadcastUuid: "uuid" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LkNotificationService(
      new ConfigService({
        LK_BASE_URL: "https://lk.example",
        LK_EDO_INTERNAL_TOKEN: "test",
      }),
    );

    const input = {
      recipientCodes1c: ["HR1"],
      title: "t",
      content: "c",
      fingerprint: "custom-fingerprint-123",
    };
    await service.sendNotification(input as unknown as SendLkNotificationInput);

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.fingerprint).toBeUndefined();
    expect(sentBody.title).toBe("t");
  });
});
