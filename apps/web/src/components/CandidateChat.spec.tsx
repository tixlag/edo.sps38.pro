import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CandidateChat } from "./CandidateChat";
import {
  clearChatDrafts,
  chatDraftKey,
  readChatDraft,
} from "../lib/chat-drafts";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  upload: vi.fn(),
  link: vi.fn(),
  canSend: true,
  receipt: undefined as unknown,
  context: {
    recipients: [
      { id: "chat-1", channel: "lk", label: "Чат ЛК", supportsFiles: true },
      {
        id: "phone",
        channel: "sms",
        label: "+79990000000",
        supportsFiles: false,
      },
    ],
    templates: [
      { id: "greeting", title: "Приветствие", text: "Здравствуйте!" },
    ],
    canSend: true,
    lkUrl: null,
    unavailableSources: [],
  },
  latest: {
    items: [
      {
        id: "erp:1",
        channel: "sms",
        outgoing: true,
        author: "Проверяющий",
        createdAt: "2026-10-20T01:00:00Z",
        text: "Мы получили ваши документы",
        attachments: [],
      },
    ],
    nextCursor: null,
    unavailableSources: [],
  },
}));
vi.mock("@edo/api-client", () => ({
  useGetCommunicationContext: () => ({
    data: { ...mocks.context, canSend: mocks.canSend },
    refetch: vi.fn(),
  }),
  useListCommunicationMessages: () => ({
    data: mocks.latest,
    refetch: vi.fn(),
  }),
  getListCommunicationMessagesQueryKey: (id: string) => ["chat", id],
  getGetCommunicationContextQueryKey: (id: string) => ["context", id],
  getGetCommunicationOperationQueryKey: (id: string, operation: string) => [
    "operation",
    id,
    operation,
  ],
  useGetCommunicationOperation: () => ({ data: mocks.receipt }),
  useSendCommunicationMessage: () => ({ mutate: mocks.send, isPending: false }),
  useUploadCommunicationAttachment: () => ({
    mutate: mocks.upload,
    isPending: false,
  }),
  useCreateCommunicationLkLink: () => ({
    mutate: mocks.link,
    isPending: false,
  }),
  createCommunicationStreamGrant: vi.fn(),
  subscribeCommunicationUpdates: () => () => undefined,
  getCommunicationAttachmentDownload: vi.fn(),
}));

let root: Root, host: HTMLDivElement, cache: QueryClient;
async function mount(candidateId = "c1") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <CandidateChat key={candidateId} candidateId={candidateId} />
      </QueryClientProvider>,
    ),
  );
}
async function type(text: string) {
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView ??= () => undefined;
  clearChatDrafts();
  mocks.send.mockReset();
  mocks.upload.mockReset();
  mocks.link.mockReset();
  mocks.receipt = undefined;
  mocks.canSend = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  cache.clear();
});

describe("candidate chat composer", () => {
  it("clears the visible draft when the authenticated session changes", async () => {
    await mount();
    await type("Личный черновик");
    await act(async () => clearChatDrafts());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(readChatDraft(chatDraftKey("c1", "lk", "chat-1")).text).toBe("");
  });
  it("shows mixed-channel history and prohibits files for SMS", async () => {
    await mount();
    expect(host.textContent).toContain("Мы получили ваши документы");
    const select = host.querySelector(
      'select[aria-label="Канал и получатель"]',
    )! as HTMLSelectElement;
    await act(async () => {
      select.value = "sms:phone";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      (host.querySelector('input[type="file"]') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(host.textContent).toContain("SMS поддерживает только текст");
  });
  it("preserves separate in-memory drafts for candidates and channels", async () => {
    await mount();
    await type("Черновик первого кандидата");
    expect(readChatDraft(chatDraftKey("c1", "lk", "chat-1")).text).toBe(
      "Черновик первого кандидата",
    );
    await mount("c2");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "",
    );
    await type("Другой черновик");
    await mount("c1");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Черновик первого кандидата",
    );
  });
  it("retains the request ID after a transport error so an explicit retry is idempotent", async () => {
    mocks.send.mockImplementation((_request, options) => options.onError());
    await mount();
    await type("Проверка");
    await act(async () => button("Отправить").click());
    await act(async () => button("Отправить").click());
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][0].data.requestId).toEqual(
      mocks.send.mock.calls[1][0].data.requestId,
    );
    expect(host.textContent).toContain(
      "повторное сообщение не будет отправлено",
    );
  });
  it("clears a confirmed message and never automatically replays UNKNOWN", async () => {
    mocks.send.mockImplementation((_request, options) =>
      options.onSuccess({
        id: "operation",
        status: "UNKNOWN",
        providerId: null,
        errorCode: "TIMEOUT",
      }),
    );
    await mount();
    await type("Проверка");
    await act(async () => button("Отправить").click());
    expect(
      (host.querySelector("textarea") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Результат отправки неизвестен");
    // The receipt read is the authority after reconnecting to the screen.
    mocks.receipt = { id: "operation", status: "UNKNOWN" };
    await mount();
    await act(async () => button("Начать новое сообщение").click());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "",
    );
    mocks.receipt = undefined;
    mocks.send.mockImplementation((_request, options) =>
      options.onSuccess({
        id: "operation2",
        status: "SENT",
        providerId: "p2",
        errorCode: null,
      }),
    );
    await type("Новое сообщение");
    await act(async () => button("Отправить").click());
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });
  it("keeps history visible for users without send permission", async () => {
    mocks.canSend = false;
    await mount();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toContain("Мы получили ваши документы");
    expect(host.textContent).toContain("право проверки документов");
  });
});
