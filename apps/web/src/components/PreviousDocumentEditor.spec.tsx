import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { PreviousDocumentEditor } from "./PreviousDocumentEditor";
const state = vi.hoisted(() => ({ status: "FAILED", retry: vi.fn() }));
vi.mock("@edo/api-client", () => ({
  useGetPreviousDocumentDetails: () => ({
    data: {
      revision: 1,
      fields: [],
      document: { originalAvailable: false },
      erpEditSyncStatus: state.status,
      erpEditSyncError: "ERP_UNAVAILABLE",
    },
  }),
  useEditPreviousDocumentFields: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryPreviousDocumentErpEdit: () => ({
    mutate: state.retry,
    isPending: false,
  }),
  getGetPreviousDocumentDetailsQueryKey: () => ["previous-document"],
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("claims ERP confirmation only after confirmation and retries the saved document on failure", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient();
  const render = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <PreviousDocumentEditor
            candidateId="candidate"
            documentId="document"
            onState={vi.fn()}
          />
        </QueryClientProvider>,
      ),
    );
  try {
    render();
    expect(host.textContent).toContain("не подтверждены в ERP");
    const retry = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Повторить отправку"),
    )!;
    act(() => retry.click());
    expect(state.retry).toHaveBeenCalledWith(
      { candidateId: "candidate", documentId: "document" },
      expect.any(Object),
    );
    state.status = "PENDING";
    render();
    expect(host.textContent).toContain("Подтверждение ERP ожидается");
    expect(host.textContent).not.toContain("Исправления подтверждены в ERP");
    state.status = "CONFIRMED";
    render();
    expect(host.textContent).toContain("Исправления подтверждены в ERP");
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
