import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useVisibleRuDocumentSync } from "./use-visible-ru-document-sync";
const batch = vi.hoisted(() => vi.fn());
vi.mock("@edo/api-client", () => ({
  useRequestCandidateEnrichmentBatch: () => ({ mutate: batch }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, node: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  node?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("requests the visible page once, polls unfinished work and stops when ready", async () => {
  vi.useFakeTimers();
  const refetch = vi.fn().mockResolvedValue(undefined);
  function View({ ids }: { ids: string[] }) {
    const state = useVisibleRuDocumentSync(ids, true, refetch);
    return <span>{[...state.pendingIds].join(",")}</span>;
  }
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<View ids={["a", "b"]} />));
  expect(batch.mock.calls[0][0]).toEqual({
    data: { candidateIds: ["a", "b"] },
  });
  await act(async () => root.render(<View ids={["a", "b"]} />));
  expect(batch).toHaveBeenCalledTimes(1);
  await act(async () =>
    batch.mock.calls[0][1].onSuccess({ pendingCandidateIds: ["b"] }),
  );
  expect(node.textContent).toBe("b");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(batch).toHaveBeenCalledTimes(2);
  await act(async () =>
    batch.mock.calls[1][1].onSuccess({ pendingCandidateIds: [] }),
  );
  expect(node.textContent).toBe("");
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(batch).toHaveBeenCalledTimes(2);
  await act(async () => root.render(<View ids={["c"]} />));
  expect(batch.mock.calls[2][0]).toEqual({ data: { candidateIds: ["c"] } });
  expect(refetch).toHaveBeenCalledTimes(2);
});
