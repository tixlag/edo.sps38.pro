import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDocumentStatuses } from "@edo/api-client";

function streamResponse(
  stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }),
): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("document SSE reconnects", () => {
  let stop: (() => void) | undefined;
  const connect = vi.fn(async (_refreshToken: boolean) => ({
    url: "/api/v1/document-status-events",
    token: "access-token",
  }));

  beforeEach(() => {
    vi.useFakeTimers();
    connect.mockClear();
  });
  afterEach(() => {
    stop?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("backs off even when each closed stream returns 200 and a snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      streamResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: documents\ndata: {"items":[]}\n\n',
              ),
            );
            controller.close();
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onDocuments = vi.fn();
    stop = subscribeDocumentStatuses({ connect, onDocuments });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(calls + 1);
    }
    expect(onDocuments).toHaveBeenCalledTimes(8);
    expect(connect.mock.calls.every(([refresh]) => refresh === false)).toBe(
      true,
    );
  });

  it("resets the delay only after a stream stays open for a minute", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => streamResponse())
      .mockImplementationOnce(async () => streamResponse())
      .mockImplementationOnce(async () =>
        streamResponse(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
        ),
      )
      .mockImplementation(async () => streamResponse());
    vi.stubGlobal("fetch", fetchMock);
    stop = subscribeDocumentStatuses({ connect, onDocuments: vi.fn() });
    await vi.advanceTimersByTimeAsync(9000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60000);
    controller!.close();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("refreshes once after 401 and stops if the refreshed token is rejected", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    stop = subscribeDocumentStatuses({ connect, onDocuments: vi.fn() });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls.map(([refresh]) => refresh)).toEqual([
      false,
      true,
    ]);
  });

  it("does not refresh again when the request after refresh has a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockRejectedValue(new TypeError("Network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    stop = subscribeDocumentStatuses({ connect, onDocuments: vi.fn() });
    await vi.advanceTimersByTimeAsync(10000);
    expect(connect.mock.calls.map(([refresh]) => refresh)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("stops if refreshing the session fails", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const sessionConnect = vi.fn(async (refreshToken: boolean) => {
      if (refreshToken) throw new Error("Authentication required");
      return { url: "/api/v1/document-status-events", token: "old-token" };
    });
    stop = subscribeDocumentStatuses({
      connect: sessionConnect,
      onDocuments: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sessionConnect).toHaveBeenCalledTimes(2);
  });

  it("stops on forbidden access and cancels pending reconnects on unsubscribe", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    stop = subscribeDocumentStatuses({ connect, onDocuments: vi.fn() });
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    fetchMock.mockImplementation(async () => streamResponse());
    stop = subscribeDocumentStatuses({ connect, onDocuments: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
