import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { DocumentDto, DocumentListDto } from "@edo/api-client";
import { subscribeDocumentQueryUpdates } from "./document-events";
const transport = vi.hoisted(() => ({
  receive: undefined as undefined | ((data: DocumentListDto) => void),
  stop: vi.fn(),
}));
vi.mock("@edo/api-client", () => ({
  getDocumentStreamConnection: vi.fn(),
  subscribeDocumentStatuses: (options: {
    onDocuments: (data: DocumentListDto) => void;
  }) => {
    transport.receive = options.onDocuments;
    return transport.stop;
  },
}));
const doc = (id: string, candidateId: string, revision = 1) =>
  ({
    id,
    candidateId,
    revision,
    currentVersion: 1,
    status: "APPROVED",
    deliveryStatus: "SENT",
  }) as DocumentDto;
describe("document snapshot cache updates", () => {
  let client: QueryClient, stop: () => void;
  let unsubscribes: Array<() => void>;
  beforeEach(async () => {
    vi.useFakeTimers();
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      },
    });
    unsubscribes = [];
    stop = subscribeDocumentQueryUpdates(client);
    transport.receive!({ items: [doc("a", "ca"), doc("b", "cb")] });
    await vi.advanceTimersByTimeAsync(100);
  });
  afterEach(() => {
    stop();
    unsubscribes.forEach((fn) => fn());
    client.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  const changed = () =>
    transport.receive!({ items: [doc("a", "ca", 2), doc("b", "cb")] });
  function observe(path: string, queryFn = vi.fn(async () => "fresh")) {
    const observer = new QueryObserver(client, {
      queryKey: [path],
      queryFn,
      initialData: "cached",
      staleTime: Infinity,
    });
    unsubscribes.push(observer.subscribe(() => {}));
    return queryFn;
  }
  it("refreshes only affected metadata and candidate views, excluding EDO/ERP originals", async () => {
    const paths = [
      "/api/v1/documents/a/versions/1",
      "/api/v1/candidates/ca",
      "/api/v1/candidates/ca/communications/messages",
      "/api/v1/candidate-review-queue",
      "/api/v1/documents/b/versions/1",
      "/api/v1/candidates/cb",
      "/api/v1/documents/a/versions/1/files/f/file",
      "/api/v1/candidates/ca/previous-documents/p/original",
    ];
    const calls = paths.map((path) => observe(path));
    changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.map((fn) => fn.mock.calls.length)).toEqual([
      1, 1, 1, 1, 0, 0, 0, 0,
    ]);
    changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((fn) => fn.mock.calls.length)).toEqual([
      1, 1, 1, 1, 0, 0, 0, 0,
    ]);
  });
  it("keeps a slow request running and performs one trailing refresh for newer events", async () => {
    let resolve: ((value: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const fn = vi
      .fn()
      .mockImplementationOnce((ctx: { signal: AbortSignal }) => {
        signal = ctx.signal;
        return new Promise<string>((done) => (resolve = done));
      })
      .mockResolvedValue("latest");
    observe("/api/v1/documents/a/versions/1", fn);
    changed();
    await vi.advanceTimersByTimeAsync(100);
    transport.receive!({ items: [doc("a", "ca", 3), doc("b", "cb")] });
    transport.receive!({ items: [doc("a", "ca", 4), doc("b", "cb")] });
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(signal!.aborted).toBe(false);
    resolve!("older");
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["/api/v1/documents/a/versions/1"])).toBe(
      "latest",
    );
  });
  it("refreshes removed documents but cancels a queued batch on unsubscribe", async () => {
    const fn = observe("/api/v1/documents/a");
    transport.receive!({ items: [doc("b", "cb")] });
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
    changed();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
