import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell, resolveNotificationTarget, getLkNotificationWsUrl } from "./NotificationBell";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    if (this.onclose) this.onclose();
  }
}

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  lkRead: vi.fn(),
  contractRead: vi.fn(),
  contractsReadAll: vi.fn(),
  contractQuery: vi.fn(),
  invalidate: vi.fn(),
  notificationsRefetch: vi.fn(),
  contractsRefetch: vi.fn(),
  lkError: false,
  contractError: false,
  contractTotal: 1,
  userUuid: "test-user-uuid",
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidate }) }));
vi.mock("@edo/api-client", () => ({
  useGetMe: () => ({ data: { uuid: state.userUuid } }),
  getGetMyNotificationsQueryKey: () => ["lk"],
  getListSigningNotificationsQueryKey: () => ["contracts"],
  useGetMyNotifications: () => ({
    data: state.lkError
      ? undefined
      : {
          unreadCount: 1,
          items: [
            {
              uuid: "lk-1",
              title: "ЛК",
              content: "Сообщение",
              createdAt: "2026-11-03T10:00:00Z",
              readAt: null,
              target: { type: "signing_contract", url: "/signing?contractId=contract-2" },
            },
          ],
        },
    isPending: false,
    isError: state.lkError,
    refetch: state.notificationsRefetch,
  }),
  useListSigningNotifications: (params: unknown) => {
    state.contractQuery(params);
    return {
      data: state.contractError
        ? undefined
        : {
            total: state.contractTotal,
            items: [
              {
                id: "pending-1",
                contractId: "contract-1",
                message: "Договор ожидает доставки",
                createdAt: "2026-11-03T11:00:00Z",
                readAt: null,
              },
            ],
          },
      isPending: false,
      isError: state.contractError,
      isFetching: false,
      refetch: state.contractsRefetch,
    };
  },
  useMarkNotificationsRead: () => ({ mutateAsync: state.lkRead, isPending: false }),
  useReadSigningNotification: () => ({ mutateAsync: state.contractRead, isPending: false }),
  useReadAllSigningNotifications: () => ({ mutateAsync: state.contractsReadAll, isPending: false }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<NotificationBell canReadContracts />));
  const bell = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
  await act(async () => bell.click());
  return container;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  state.lkError = false;
  state.contractError = false;
  state.contractTotal = 1;
  state.userUuid = "test-user-uuid";
});

describe("NotificationBell", () => {
  it("resolves LK, surveys and EDO targets while rejecting unsafe schemes", () => {
    expect(resolveNotificationTarget("/public/news", "news", "https://edo.example", "https://lk.example")?.href).toBe("https://lk.example/public/news");
    expect(resolveNotificationTarget("/tasks/1", "surveys_platform", "https://edo.example", "https://lk.example")?.href).toBe("https://lk.example/surveys/tasks/1");
    expect(resolveNotificationTarget("/review", "document_expiration", "https://edo.example", "https://lk.example")?.href).toBe("https://edo.example/review");
    expect(resolveNotificationTarget("javascript:alert(1)", "news", "https://edo.example", "https://lk.example")).toBeNull();
  });

  it("builds correct WebSocket URL from lkBaseUrl", () => {
    const wsUrl = getLkNotificationWsUrl("user-abc-123");
    expect(wsUrl).toContain("/ws/notification?user_uuid=user-abc-123");
    expect(wsUrl).toMatch(/^wss?:\/\//);
  });

  it("shows pending contracts when LK fails and opens them through the contract read endpoint", async () => {
    state.lkError = true;
    const view = await render();
    expect(view.textContent).toContain("Не удалось загрузить уведомления");
    const item = [...view.querySelectorAll("button")].find((button) => button.textContent?.includes("Договор ожидает доставки"))!;
    await act(async () => item.click());
    expect(state.contractRead).toHaveBeenCalledWith({ id: "pending-1" });
    expect(state.navigate).toHaveBeenCalledWith({ to: "/signing", search: { contractId: "contract-1" } });
  });

  it("marks both sources read and preserves query parameters on LK links", async () => {
    const view = await render();
    expect(view.querySelector('button[aria-expanded]')?.getAttribute("aria-label")).toContain("2 непрочитанных");
    await act(async () => [...view.querySelectorAll("button")].find((button) => button.textContent?.includes("Прочитать все"))!.click());
    expect(state.lkRead).toHaveBeenCalledWith({ data: { all: true } });
    expect(state.contractsReadAll).toHaveBeenCalled();
    await act(async () => [...view.querySelectorAll("button")].find((button) => button.textContent?.includes("Сообщение"))!.click());
    expect(state.navigate).toHaveBeenCalledWith({ to: "/signing", search: { contractId: "contract-2" }, hash: "" });
  });

  it("counts all pending contracts and pages beyond 100", async () => {
    state.contractTotal = 125;
    const view = await render();
    expect(view.querySelector('button[aria-expanded]')?.getAttribute("aria-label")).toContain("126 непрочитанных");
    await act(async () => [...view.querySelectorAll("button")].find((button) => button.textContent === "Далее")!.click());
    expect(state.contractQuery).toHaveBeenLastCalledWith({ limit: 30, offset: 30 });
    await act(async () => [...view.querySelectorAll("button")].find((button) => button.textContent?.includes("Прочитать все"))!.click());
    expect(state.contractsReadAll).toHaveBeenCalled();
    expect(state.contractQuery).toHaveBeenLastCalledWith({ limit: 30, offset: 0 });
  });

  it("connects to WebSocket and invalidates queries on incoming message", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<NotificationBell canReadContracts />));

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("/ws/notification?user_uuid=test-user-uuid");

    // Message event -> invalidateQueries
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "notification" }) });
    });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["lk"] });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["contracts"] });
  });

  it("refetches both notifications and contracts when opened", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<NotificationBell canReadContracts />));

    const bell = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => bell.click());

    expect(state.notificationsRefetch).toHaveBeenCalled();
    expect(state.contractsRefetch).toHaveBeenCalled();
  });

  it("reconciles REST data upon WebSocket reconnect", async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<NotificationBell canReadContracts />));

    expect(MockWebSocket.instances.length).toBe(1);
    const ws1 = MockWebSocket.instances[0];

    // Trigger disconnect
    await act(async () => {
      ws1.onclose?.();
    });

    // Advance timer to trigger reconnect
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(MockWebSocket.instances.length).toBe(2);
    const ws2 = MockWebSocket.instances[1];

    // Reconnection open -> refresh
    state.invalidate.mockClear();
    await act(async () => {
      ws2.onopen?.();
    });

    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["lk"] });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["contracts"] });
    vi.useRealTimers();
  });
});
