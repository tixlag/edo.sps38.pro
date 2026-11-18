import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useVisibleRuDocumentSync } from "./use-visible-ru-document-sync";

const batch = vi.hoisted(() => vi.fn());
const getBatchStatus = vi.hoisted(() => vi.fn());
const eventListeners = vi.hoisted(() => new Set<(event: any) => void>());
const stateListeners = vi.hoisted(() => new Set<(state: any) => void>());

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
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("useVisibleRuDocumentSync SSE & no repeated POST", () => {
  let root: Root;
  let node: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    batch.mockClear();
    getBatchStatus.mockClear();
    eventListeners.clear();
    stateListeners.clear();
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

  it("requests the visible page once and does NOT poll with repeated POST", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a", "b"]} />));

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

  it("removes candidate from pending and calls refetch when ru-enrichment READY arrives", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a", "b"]} />));
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

    expect(node.textContent).toBe("");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("handles multi-candidate SSE events with a single refetch", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a", "b", "c"]} />));
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["a", "b"] }),
    );
    expect(node.textContent).toBe("a,b");

    // SSE event delivers READY for both "a" and "b"
    await act(async () => {
      for (const listener of eventListeners) {
        listener({
          items: [
            { candidateId: "a", status: "READY", retryAt: null },
            { candidateId: "b", status: "READY", retryAt: null },
          ],
        });
      }
    });

    expect(node.textContent).toBe("");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not clear candidate on RETRY and does not trigger new POST", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a"]} />));
    await act(async () =>
      batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["a"] }),
    );
    expect(node.textContent).toBe("a");

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

    // Still pending, no refetch, no extra POST
    expect(node.textContent).toBe("a");
    expect(refetch).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("handles race condition where SSE arrives before POST response resolves", async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a"]} />));

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

  it("reconciles status on stream reconnect if pending jobs remain", async () => {
    getBatchStatus.mockResolvedValue({
      items: [{ candidateId: "b", status: "READY", retryAt: null }],
    });
    const refetch = vi.fn().mockResolvedValue(undefined);
    function View({ ids }: { ids: string[] }) {
      const state = useVisibleRuDocumentSync(ids, true, refetch);
      return <span>{[...state.pendingIds].join(",")}</span>;
    }

    await act(async () => root.render(<View ids={["a", "b"]} />));
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
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
