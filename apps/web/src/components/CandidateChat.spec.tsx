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
  workspace: {
    history: [] as Array<{
      date: string;
      author: string;
      statusId: string;
      statusName: string;
      comment: string;
    }>,
  },
  details: {
    documents: [] as Array<Record<string, unknown>>,
  },
}));
vi.mock("@edo/api-client", () => ({
  useGetCandidateWorkspace: () => ({
    data: mocks.workspace,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useGetCandidateDetails: () => ({
    data: mocks.details,
    isLoading: false,
    refetch: vi.fn(),
  }),
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
  mocks.workspace = { history: [] };
  mocks.details = { documents: [] };
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
  it("does not suggest an unchecked retry when LK link creation is uncertain", async () => {
    mocks.link.mockImplementation((_request, options) => options.onError());
    await mount();
    await act(async () => button("Ссылка ЛК").click());
    expect(host.textContent).toContain("Проверьте связь кандидата перед повтором");
  });
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

describe("candidate chat events and feed", () => {
  it("displays status changes and document lifecycle events in chronological order", async () => {
    mocks.workspace = {
      history: [
        {
          date: "2026-10-19T08:00:00Z",
          author: "Администратор",
          statusId: "INVITED",
          statusName: "Приглашён",
          comment: "Первичная регистрация",
        },
      ],
    };
    mocks.details = {
      documents: [
        {
          id: "doc-1",
          title: "Паспорт РФ",
          status: "APPROVED",
          currentVersion: 1,
          revision: 1,
          submittedAt: "2026-10-19T09:00:00Z",
          reviewedAt: "2026-10-19T10:00:00Z",
          reviewedBy: "Верификатор 1",
          returnedVersions: [],
        },
      ],
    };
    await mount();

    // Check status change event
    expect(host.textContent).toContain("Смена статуса:");
    expect(host.textContent).toContain("Приглашён");
    expect(host.textContent).toContain("Администратор");
    expect(host.textContent).toContain("«Первичная регистрация»");

    // Check document submitted and reviewed
    expect(host.textContent).toContain("Паспорт РФ");
    expect(host.textContent).toContain("Загружен кандидатом");
    expect(host.textContent).toContain("Документ принят");
    expect(host.textContent).toContain("Проверил: Верификатор 1");

    // Check existing message is also visible
    expect(host.textContent).toContain("Мы получили ваши документы");
  });

  it("filters feed between all, messages, and events tabs with counters", async () => {
    mocks.workspace = {
      history: [
        {
          date: "2026-10-19T08:00:00Z",
          author: "Система",
          statusId: "ONBOARDING",
          statusName: "Оформление",
          comment: "",
        },
      ],
    };
    mocks.details = { documents: [] };
    await mount();

    // Total: 1 message + 1 status event = 2
    const tabs = host.querySelectorAll('button[role="tab"]');
    expect(tabs.length).toBe(3);
    expect(tabs[0].textContent).toContain("Все");
    expect(tabs[0].textContent).toContain("2");
    expect(tabs[1].textContent).toContain("Сообщения");
    expect(tabs[1].textContent).toContain("1");
    expect(tabs[2].textContent).toContain("События");
    expect(tabs[2].textContent).toContain("1");

    // Switch to "Сообщения"
    await act(async () => {
      (tabs[1] as HTMLButtonElement).click();
    });
    expect(host.textContent).toContain("Мы получили ваши документы");
    expect(host.textContent).not.toContain("Смена статуса:");

    // Switch to "События"
    await act(async () => {
      (tabs[2] as HTMLButtonElement).click();
    });
    expect(host.textContent).not.toContain("Мы получили ваши документы");
    expect(host.textContent).toContain("Смена статуса:");
    expect(host.textContent).toContain("Оформление");
  });

  it("displays returned document version details", async () => {
    mocks.workspace = { history: [] };
    mocks.details = {
      documents: [
        {
          id: "doc-snils",
          title: "СНИЛС",
          status: "RETURNED",
          currentVersion: 1,
          revision: 1,
          submittedAt: "2026-10-19T09:00:00Z",
          reviewedAt: "2026-10-19T10:00:00Z",
          reviewedBy: "Верификатор 2",
          returnedVersions: [
            {
              version: 1,
              submittedAt: "2026-10-19T09:00:00Z",
              reviewedAt: "2026-10-19T10:00:00Z",
              reviewedBy: "Верификатор 2",
              rejectionReason: "Нечитаемый скан",
              supersededByVersion: null,
            },
          ],
        },
      ],
    };
    await mount();

    expect(host.textContent).toContain("СНИЛС (версия 1)");
    expect(host.textContent).toContain("Причина возврата: Нечитаемый скан");
  });
});
