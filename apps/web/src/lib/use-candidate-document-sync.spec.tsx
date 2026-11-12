import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCandidateDocumentSync } from "./use-candidate-document-sync";
const mock = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
vi.mock("@edo/api-client", () => ({
  useGetCandidateDetails: () => mock.result,
  useRequestCandidateEnrichment: () => ({ mutate: vi.fn(), isError: false }),
  getGetCandidateDetailsQueryKey: (id: string) => ["details", id],
  getListCandidatePreviousDocumentsQueryKey: () => ["previous"],
  getListCandidateReviewQueueQueryKey: () => ["queue"],
  getListReviewCandidatesQueryKey: () => ["candidates"],
  getListIgArrivalRegistryGroupsQueryKey: () => ["groups"],
  getListIgArrivalRegistryParticipationsQueryKey: () => ["people"],
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("complete candidate snapshots", () => {
  let root: Root,
    node: HTMLDivElement,
    view: ReturnType<typeof useCandidateDocumentSync>;
  function Probe({ id = "a", stage }: { id?: string; stage?: string }) {
    view = useCandidateDocumentSync(id, stage);
    return <p>{view.data?.candidate.fullName}</p>;
  }
  const data = (name: string, status = "READY", ready = true) => ({
    candidate: { id: name, fullName: name, reviewGroup: "IG" },
    enrichment: { status, profileReady: ready, documentsReady: ready },
    documents: [],
  });
  beforeEach(() => {
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
  });
  async function render(id = "a", stage?: string) {
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
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
});
