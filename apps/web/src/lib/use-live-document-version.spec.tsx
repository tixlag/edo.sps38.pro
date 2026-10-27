import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  AXIOS_INSTANCE,
  configureApiAuth,
  __resetApiAuthForTests,
  type DocumentVersionDto,
} from "@edo/api-client";
import { useLiveDocumentVersion } from "./use-live-document-version";
import { useDocumentEvents } from "./document-events";

let root: Root;
let client: QueryClient;
let node: HTMLDivElement;
let server: DocumentVersionDto;
const originalAdapter = AXIOS_INSTANCE.defaults.adapter;

function response(
  status: NonNullable<DocumentVersionDto["job"]>["status"],
  revision = 1,
): DocumentVersionDto {
  return {
    documentId: "document",
    version: 4,
    revision,
    status: "IN_REVIEW",
    fields: [],
    files: [],
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    reviewedByName: null,
    canStartOcr: false,
    canRetryOcr: false,
    ocrSource: null,
    ocrFields: [],
    issues: [],
    raw: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    delivery: null,
    job: { id: "job", status, errorCode: null, cleanupPending: false },
  };
}
function Probe({ events = false }: { events?: boolean }) {
  useDocumentEvents(events);
  const query = useLiveDocumentVersion("document", 4);
  return (
    <p>
      {query.data?.job?.status}:{query.data?.revision}
    </p>
  );
}
async function mount(events = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe events={events} />
      </QueryClientProvider>,
    );
  });
  await tick(0);
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("live document version through the generated API client", () => {
  const requests = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    requests.mockClear();
    server = response("UPLOADING");
    AXIOS_INSTANCE.defaults.adapter = async (config) => {
      requests(config.url);
      return {
        data: server,
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };
    configureApiAuth({
      getAccessToken: () => "test-memory-token",
      refreshAccessToken: async () => null,
    });
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    node = document.createElement("div");
    document.body.appendChild(node);
    root = createRoot(node);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    act(() => root.unmount());
    client.clear();
    node.remove();
    AXIOS_INSTANCE.defaults.adapter = originalAdapter;
    __resetApiAuthForTests();
    vi.unstubAllGlobals();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it.each(["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED"] as const)(
    "polls without SSE and stops after fetching %s",
    async (terminal) => {
      await mount();
      expect(node.textContent).toBe("UPLOADING:1");
      server = response("RUNNING");
      await tick(3000);
      await tick(1);
      expect(requests).toHaveBeenCalledTimes(2);
      expect(node.textContent).toBe("RUNNING:1");
      server = response(terminal, 2);
      await tick(3000);
      await tick(1);
      expect(node.textContent).toBe(`${terminal}:2`);
      const count = requests.mock.calls.length;
      await tick(15000);
      expect(requests).toHaveBeenCalledTimes(count);
    },
  );

  it("refreshes a completed version after focus and network recovery", async () => {
    server = response("SUCCEEDED");
    await mount();
    act(() => focusManager.setFocused(false));
    server = response("SUCCEEDED", 2);
    act(() => focusManager.setFocused(true));
    await tick(0);
    expect(node.textContent).toBe("SUCCEEDED:2");
    act(() => onlineManager.setOnline(false));
    server = response("SUCCEEDED", 3);
    act(() => onlineManager.setOnline(true));
    await tick(0);
    expect(node.textContent).toBe("SUCCEEDED:3");
  });

  it("an SSE event refreshes the open version even after polling has stopped", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    server = response("SUCCEEDED");
    await mount(true);
    server = response("SUCCEEDED", 2);
    await act(async () => {
      stream.enqueue(
        new TextEncoder().encode('event: documents\ndata: {"items":[]}\n\n'),
      );
    });
    await tick(0);
    expect(node.textContent).toBe("SUCCEEDED:2");
    expect(requests).toHaveBeenCalledTimes(2);
    stream.close();
  });
});
