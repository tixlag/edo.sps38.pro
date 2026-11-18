import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useVisibleRuDocumentSync } from "./use-visible-ru-document-sync";

const batch = vi.hoisted(() => vi.fn());
const getBatchStatus = vi.hoisted(() => vi.fn());
const eventListeners = vi.hoisted(() => new Set<(event: any) => void>());
const stateListeners = vi.hoisted(() => new Set<(state: any) => void>());
const invalidateRuSpy = vi.hoisted(() => vi.fn());

vi.mock("@edo/api-client", () => ({
  useRequestCandidateEnrichmentBatch: () => ({ mutate: batch }),
  getCandidateEnrichmentBatchStatus: (params: any) => getBatchStatus(params),
}));

vi.mock("./document-events", () => ({
  subscribeRuEnrichmentEvents: (listener: (event: any) => void) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  subscribeDocumentStreamState: (listener: (state: any) => void) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  invalidateRuEnrichmentCandidates: (client: any, ids: string[]) =>
    invalidateRuSpy(client, ids),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("useVisibleRuDocumentSync SSE & no repeated POST", () => {
  let root: Root;
  let node: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    batch.mockClear();
    getBatchStatus.mockClear();
    eventListeners.clear();
    stateListeners.clear();
    invalidateRuSpy.mockClear();
    queryClient = new QueryClient();
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    node?.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function renderView(ui: ReactElement) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
      ),
    );
  }

  it("requests the visible page once and does NOT poll with repeated POST", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await renderView(<View ids={["a", "b"]} />);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual({
      data: { candidateIds: ["a", "b"] },
    });

    // Simulate POST response returning "b" as pending
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["b"] }),
    );
    expect(node.textContent).toBe("b");

    // Initial POST response must NOT trigger refetch() (fixing the lastPending bug!)
    expect(refetch).not.toHaveBeenCalled();

    // Advance 5s, 10s, 30s: POST must NEVER be called again!
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(batch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(batch).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("removes candidate from pending without duplicate refetch when ru-enrichment READY arrives", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await renderView(<View ids={["a", "b"]} />);
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["b"] }),
    );
    expect(node.textContent).toBe("b");

    // SSE emits READY event for "b"
    await act(async () => {
      for (const listener of eventListeners) {
        listener({
          items: [{ candidateId: "b", status: "READY", retryAt: null }],
        });
      }
    });

    // Pending set is cleared
    expect(node.textContent).toBe("");
    // Centralized document-events invalidates queries; hook must NOT duplicate refetch()!
    expect(refetch).not.toHaveBeenCalled();
  });

  it("tracks candidate states and updates to RETRY without infinite spinner or refetch", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    let capturedState: ReturnType<typeof useVisibleRuDocumentSync> | undefined;
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      capturedState = state;
      return <span>{state.getSyncState("a")?.status ?? "none"}</span>;
    }

    await renderView(<View ids={["a"]} />);
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["a"] }),
    );
    expect(capturedState?.getSyncState("a")?.status).toBe("PENDING");

    // SSE delivers RETRY
    await act(async () => {
      for (const listener of eventListeners) {
        listener({
          items: [
            {
              candidateId: "a",
              status: "RETRY",
              retryAt: "2026-11-18T16:00:00.000Z",
            },
          ],
        });
      }
    });

    // Candidate state is updated to RETRY, still pending, no refetch, no extra POST
    expect(node.textContent).toBe("RETRY");
    expect(capturedState?.getSyncState("a")?.status).toBe("RETRY");
    expect(capturedState?.getSyncState("a")?.retryAt).toBe(
      "2026-11-18T16:00:00.000Z",
    );
    expect(refetch).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("handles race condition where SSE arrives before POST response resolves", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await renderView(<View ids={["a"]} />);

    // SSE arrives BEFORE batch.onSuccess is called
    await act(async () => {
      for (const listener of eventListeners) {
        listener({
          items: [{ candidateId: "a", status: "READY", retryAt: null }],
        });
      }
    });

    // Now POST response returns "a" as pending
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["a"] }),
    );

    // Because "a" completed during POST, it should NOT be kept pending!
    expect(node.textContent).toBe("");
  });

  it("reconciles status on stream reconnect if pending jobs remain, calling invalidation and refetch", async () => {
    getBatchStatus.mockResolvedValue({
      items: [{ candidateId: "b", status: "READY", retryAt: null }],
    });
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await renderView(<View ids={["a", "b"]} />);
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["b"] }),
    );
    expect(node.textContent).toBe("b");

    // Stream disconnects and reconnects
    await act(async () => {
      for (const listener of stateListeners) {
        listener("reconnecting");
      }
    });
    await act(async () => {
      for (const listener of stateListeners) {
        listener("connected");
      }
    });

    // Fallback status check resolved "b" as READY
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getBatchStatus).toHaveBeenCalledWith({ candidateIds: ["b"] });
    expect(node.textContent).toBe("");
    // Fallback discovers READY, so it MUST invalidate queries and refetch
    expect(invalidateRuSpy).toHaveBeenCalledWith(queryClient, ["b"]);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("prevents stale GET responses from regressing completed candidates to pending", async () => {
    let resolveStaleGet: ((data: any) => void) | undefined;
    getBatchStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStaleGet = resolve;
        }),
    );
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await renderView(<View ids={["a"]} />);
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["a"] }),
    );
    expect(node.textContent).toBe("a");

    // Reconnection triggers checkStatus (GET), which is slow/in-flight
    await act(async () => {
      for (const listener of stateListeners) {
        listener("reconnecting");
      }
    });
    await act(async () => {
      for (const listener of stateListeners) {
        listener("connected");
      }
    });
    expect(getBatchStatus).toHaveBeenCalledTimes(1);

    // In the meantime, SSE delivers READY for "a"!
    await act(async () => {
      for (const listener of eventListeners) {
        listener({
          items: [{ candidateId: "a", status: "READY", retryAt: null }],
        });
      }
    });
    expect(node.textContent).toBe("");

    // Now the slow stale GET resolves with old RUNNING status
    await act(async () => {
      resolveStaleGet?.({
        items: [{ candidateId: "a", status: "RUNNING", retryAt: null }],
      });
    });

    // Candidate MUST remain READY and not be reverted to pending!
    expect(node.textContent).toBe("");
  });
});
