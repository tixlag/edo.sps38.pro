import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DocumentReturnNotifications } from "./DocumentReturnNotifications";
const mocks = vi.hoisted(() => ({ retry: vi.fn(), status: "FAILED" }));
vi.mock("@edo/api-client", () => ({
  useListDocumentReturnNotifications: () => ({
    data: [{ id: "operation", status: mocks.status }],
  }),
  useRetryDocumentReturnNotification: () => ({
    mutate: mocks.retry,
    isPending: false,
  }),
  getListDocumentReturnNotificationsQueryKey: () => ["notifications"],
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("allows retry only for a known failure and keeps uncertain delivery separate from document status", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const client = new QueryClient();
  const render = () =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <DocumentReturnNotifications documentId="document" />
        </QueryClientProvider>,
      ),
    );
  try {
    render();
    expect(host.textContent).toContain("Статус документа сохранён");
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.retry).toHaveBeenCalledWith(
      { documentId: "document", operationId: "operation" },
      expect.any(Object),
    );
    mocks.status = "UNKNOWN";
    render();
    expect(host.textContent).toContain("не подтверждена");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
