import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCandidateDocumentSync } from "./use-candidate-document-sync";

const mock = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  lastOptions: {} as Record<string, unknown>,
  mutate: vi.fn(),
  getBatchStatus: vi.fn(),
  invalidateRuSpy: vi.fn(),
}));
const sseListeners = vi.hoisted(() => new Set<(event: any) => void>());
const stateListeners = vi.hoisted(() => new Set<(state: any) => void>());

vi.mock("@edo/api-client", () => ({
  useGetCandidateDetails: (_id: string, _params: any, options: any) => {
    mock.lastOptions = options;
    return mock.result;
  },
  useRequestCandidateEnrichment: () => ({
    mutate: mock.mutate,
    isPending: false,
    isError: false,
  }),
  getCandidateEnrichmentBatchStatus: (params: any) => mock.getBatchStatus(params),
  getGetCandidateDetailsQueryKey: (id: string) => ["details", id],
  getListCandidatePreviousDocumentsQueryKey: () => ["previous"],
  getListCandidateReviewQueueQueryKey: () => ["queue"],
  getListReviewCandidatesQueryKey: () => ["candidates"],
  getListIgArrivalRegistryGroupsQueryKey: () => ["groups"],
  getListIgArrivalRegistryParticipationsQueryKey: () => ["people"],
}));

vi.mock("./document-events", () => ({
  subscribeRuEnrichmentEvents: (fn: any) => {
    sseListeners.add(fn);
    return () => sseListeners.delete(fn);
  },
  subscribeDocumentStreamState: (fn: any) => {
    stateListeners.add(fn);
    return () => stateListeners.delete(fn);
  },
  getDocumentStreamState: vi.fn(() => "connected"),
  invalidateRuEnrichmentCandidates: (client: any, ids: string[]) =>
    mock.invalidateRuSpy(client, ids),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("complete candidate snapshots", () => {
  let root: Root,
    node: HTMLDivElement,
    client: QueryClient,
    view: ReturnType<typeof useCandidateDocumentSync>;

  function Probe({ id = "a", stage }: { id?: string; stage?: string }) {
    view = useCandidateDocumentSync(id, stage);
    return <p>{view.data?.candidate.fullName}</p>;
  }

  const data = (
    name: string,
    status = "READY",
    ready = true,
    reviewGroup = "IG",
  ) => ({
    candidate: { id: name, fullName: name, reviewGroup },
    enrichment: { status, profileReady: ready, documentsReady: ready },
    documents: [],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mock.mutate.mockClear();
    mock.getBatchStatus.mockClear();
    mock.invalidateRuSpy.mockClear();
    sseListeners.clear();
    stateListeners.clear();
    client = new QueryClient();
    mock.result = {
      data: data("a"),
      isError: false,
      isLoading: false,
      dataUpdatedAt: 1,
      refetch: vi.fn().mockResolvedValue({}),
    };
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
    vi.useRealTimers();
  });

  async function render(id = "a", stage?: string) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe id={id} stage={stage} />
        </QueryClientProvider>,
      ),
    );
  }

  it("keeps the last complete snapshot while a later response is incomplete", async () => {
    await render();
    mock.result = {
      ...mock.result,
      data: data("partial", "RUNNING", false),
      dataUpdatedAt: 2,
    };
    await render();
    expect(view!.data?.candidate.fullName).toBe("a");
    expect(view!.synchronizing).toBe(false);
    expect(view!.updating).toBe(true);
  });

  it("does not display an incomplete initial snapshot as completed data", async () => {
    mock.result = { ...mock.result, data: data("partial", "RUNNING", false) };
    await render();
    expect(view!.synchronizing).toBe(true);
    expect(view!.updating).toBe(false);
  });

  it("does not transfer a saved snapshot to a different candidate", async () => {
    await render();
    mock.result = { ...mock.result, data: data("b", "RUNNING", false) };
    await render("b");
    expect(view!.synchronizing).toBe(true);
    expect(node.textContent).not.toBe("a");
  });

  it("keeps a snapshot for network failure but discards it on forbidden access", async () => {
    await render();
    mock.result = {
      ...mock.result,
      isError: true,
      error: { response: { status: 503 } },
    };
    await render();
    expect(view!.isError).toBe(false);
    expect(view!.updating).toBe(true);
    mock.result = { ...mock.result, error: { response: { status: 403 } } };
    await render();
    expect(view!.isError).toBe(true);
    expect(view!.data).toBeUndefined();
  });

  it("does not display a previous stage snapshot under a new stage", async () => {
    await render("a", "1");
    mock.result = { ...mock.result, data: data("partial", "RUNNING", false) };
    await render("a", "7");
    expect(view!.synchronizing).toBe(true);
    expect(node.textContent).not.toBe("a");
  });

  it("disables 5s polling for RU candidate, keeps 5s for IG", async () => {
    await render("ru-cand");
    const refetchInterval = (mock.lastOptions as any)?.query?.refetchInterval;
    expect(refetchInterval).toBeDefined();

    // RU candidate: returns false (handled via SSE and 60s fallback status checks)
    const ruQuery = {
      state: {
        data: {
          candidate: { reviewGroup: "RU" },
          enrichment: { status: "RUNNING" },
        },
      },
    };
    expect(refetchInterval(ruQuery)).toBe(false);

    // IG candidate: returns 5000 (retaining IG polling behavior)
    const igQuery = {
      state: {
        data: {
          candidate: { reviewGroup: "IG" },
          enrichment: { status: "RUNNING" },
        },
      },
    };
    expect(refetchInterval(igQuery)).toBe(5000);
  });

  it("updates local state on SSE READY without triggering duplicate client invalidations", async () => {
    mock.result = {
      ...mock.result,
      data: data("candidate-x", "RUNNING", false, "RU"),
    };
    await render("candidate-x");

    await act(async () => {
      for (const listener of sseListeners) {
        listener({
          items: [
            { candidateId: "candidate-x", status: "READY", retryAt: null },
          ],
        });
      }
    });

    // Centralized document-events handles invalidation; hook does not duplicate
    expect(mock.invalidateRuSpy).not.toHaveBeenCalled();
  });

  it("runs rare 60s fallback check via getCandidateEnrichmentBatchStatus and invalidates queries on discovering READY", async () => {
    mock.getBatchStatus.mockResolvedValue({
      items: [{ candidateId: "cand-ru", status: "READY", retryAt: null }],
    });
    mock.result = {
      ...mock.result,
      data: data("cand-ru", "RUNNING", false, "RU"),
    };
    await render("cand-ru");

    // Advance 30s: fallback does not fire
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mock.getBatchStatus).not.toHaveBeenCalled();

    // Advance to 60s: fallback fires for this active candidate
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(mock.getBatchStatus).toHaveBeenCalledWith({
      candidateIds: ["cand-ru"],
    });

    // Ready item discovered via fallback GET check triggers query invalidation!
    expect(mock.invalidateRuSpy).toHaveBeenCalledWith(client, ["cand-ru"]);
  });

  it("starts fallback check even when initial snapshot had READY if a new sync was requested", async () => {
    mock.getBatchStatus.mockResolvedValue({
      items: [{ candidateId: "ru-ready-initial", status: "READY", retryAt: null }],
    });
    // Initial snapshot is READY, but RU always queues a sync on open (needsRequest)
    mock.result = {
      ...mock.result,
      data: data("ru-ready-initial", "READY", true, "RU"),
    };
    await render("ru-ready-initial");

    // mutate was called for RU
    expect(mock.mutate).toHaveBeenCalled();

    // While awaitingRefresh, advance 60s
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(mock.getBatchStatus).toHaveBeenCalledWith({
      candidateIds: ["ru-ready-initial"],
    });
  });

  it("preserves reconnection listener state across re-renders and re-checks status on reconnect", async () => {
    mock.getBatchStatus.mockResolvedValue({
      items: [{ candidateId: "reconnect-cand", status: "READY", retryAt: null }],
    });
    mock.result = {
      ...mock.result,
      data: data("reconnect-cand", "RUNNING", false, "RU"),
    };
    await render("reconnect-cand");

    // Trigger state change / re-render
    mock.result = {
      ...mock.result,
      dataUpdatedAt: 2,
    };
    await render("reconnect-cand");

    // State disconnects
    await act(async () => {
      for (const listener of stateListeners) {
        listener("reconnecting");
      }
    });

    // Another re-render while reconnecting (must NOT reset wasReconnecting!)
    mock.result = {
      ...mock.result,
      dataUpdatedAt: 3,
    };
    await render("reconnect-cand");

    // Stream reconnects
    await act(async () => {
      for (const listener of stateListeners) {
        listener("connected");
      }
    });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    // Since candidate was pending, reconnect triggered status check
    expect(mock.getBatchStatus).toHaveBeenCalledWith({
      candidateIds: ["reconnect-cand"],
    });
    expect(mock.invalidateRuSpy).toHaveBeenCalledWith(client, [
      "reconnect-cand",
    ]);
  });

  it("updates syncState to RETRY on SSE event without triggering new POST or full invalidation", async () => {
    mock.result = {
      ...mock.result,
      data: data("cand-retry", "RUNNING", false, "RU"),
    };
    await render("cand-retry");

    // SSE emits RETRY
    await act(async () => {
      for (const listener of sseListeners) {
        listener({
          items: [
            {
              candidateId: "cand-retry",
              status: "RETRY",
              retryAt: "2026-11-18T16:00:00.000Z",
            },
          ],
        });
      }
    });

    expect(view!.syncState?.status).toBe("RETRY");
    expect(view!.syncState?.retryAt).toBe("2026-11-18T16:00:00.000Z");
    expect(view!.syncError).toBe(true);
    // Did NOT call invalidateRuEnrichmentCandidates on RETRY
    expect(mock.invalidateRuSpy).not.toHaveBeenCalled();
    // Did NOT trigger extra mutate call
    expect(mock.mutate).toHaveBeenCalledTimes(1); // initial mount only
  });

  it("updates syncState to RETRY on fallback GET check without triggering full invalidation", async () => {
    mock.getBatchStatus.mockResolvedValue({
      items: [
        {
          candidateId: "cand-get-retry",
          status: "RETRY",
          retryAt: "2026-11-18T16:00:00.000Z",
        },
      ],
    });
    mock.result = {
      ...mock.result,
      data: data("cand-get-retry", "RUNNING", false, "RU"),
    };
    await render("cand-get-retry");

    // Advance 60s to trigger fallback GET
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(mock.getBatchStatus).toHaveBeenCalledWith({
      candidateIds: ["cand-get-retry"],
    });

    expect(view!.syncState?.status).toBe("RETRY");
    expect(view!.syncError).toBe(true);
    expect(mock.invalidateRuSpy).not.toHaveBeenCalled();
  });

  it("transitions from RETRY to READY on SSE event and prevents late stale GET from regressing state", async () => {
    let resolveStaleGet: ((data: any) => void) | undefined;
    mock.getBatchStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStaleGet = resolve;
        }),
    );
    mock.result = {
      ...mock.result,
      data: data("cand-monotonic", "RUNNING", false, "RU"),
    };
    await render("cand-monotonic");

    // Reconnection triggers checkStatus (GET in-flight)
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
    expect(mock.getBatchStatus).toHaveBeenCalledTimes(1);

    // Meanwhile, SSE delivers READY!
    await act(async () => {
      for (const listener of sseListeners) {
        listener({
          items: [
            { candidateId: "cand-monotonic", status: "READY", retryAt: null },
          ],
        });
      }
    });

    expect(view!.syncState?.status).toBe("READY");

    // Now late GET resolves with old RETRY
    await act(async () => {
      resolveStaleGet?.({
        items: [
          {
            candidateId: "cand-monotonic",
            status: "RETRY",
            retryAt: "2026-11-18T16:00:00.000Z",
          },
        ],
      });
    });

    // Monotonic guard: state MUST remain READY!
    expect(view!.syncState?.status).toBe("READY");
    expect(mock.invalidateRuSpy).not.toHaveBeenCalled();
  });

  it("does not execute state update or invalidation if unmounted before GET finishes on reconnect", async () => {
    let resolveGet: ((data: any) => void) | undefined;
    mock.getBatchStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );
    mock.result = {
      ...mock.result,
      data: data("cand-unmount", "RUNNING", false, "RU"),
    };
    await render("cand-unmount");

    // Trigger reconnect check
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
    expect(mock.getBatchStatus).toHaveBeenCalledWith({
      candidateIds: ["cand-unmount"],
    });

    // Unmount the component BEFORE GET resolves
    await act(async () => root.unmount());

    // Now GET resolves with READY
    await act(async () => {
      resolveGet?.({
        items: [
          { candidateId: "cand-unmount", status: "READY", retryAt: null },
        ],
      });
    });

    // Because card was unmounted, invalidation from old card must NOT be called!
    expect(mock.invalidateRuSpy).not.toHaveBeenCalled();
  });
});
