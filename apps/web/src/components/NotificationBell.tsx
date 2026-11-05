import * as React from "react";
import { Bell, LoaderCircle, CheckCheck } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMyNotificationsQueryKey,
  useGetMyNotifications,
  useMarkNotificationsRead,
  getListSigningNotificationsQueryKey,
  useListSigningNotifications,
  useReadSigningNotification,
  useReadAllSigningNotifications,
  useGetMe,
} from "@edo/api-client";
import { formatDateTimeRu } from "../lib/date-format";
import { lkBaseUrl } from "../lib/review-groups";

const CONTRACT_PAGE_SIZE = 30;

export function resolveNotificationTarget(targetUrl: string, targetType: string | undefined, currentOrigin: string, lkOrigin: string): URL | null {
  if (targetUrl.startsWith("//")) return null;
  try {
    const isEdo = targetType === "document_expiration" || targetType === "signing_contract";
    const base = isEdo ? currentOrigin : targetType === "surveys_platform" ? `${lkOrigin.replace(/\/$/, "")}/surveys/` : lkOrigin;
    const path = targetType === "surveys_platform" && targetUrl.startsWith("/") ? targetUrl.slice(1) : targetUrl;
    const url = new URL(path, base);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function getLkNotificationWsUrl(userUuid: string): string {
  const raw = (
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_LK_BASE_URL as string | undefined) ||
    lkBaseUrl()
  ).trim();
  const withoutSlash = raw.replace(/\/+$/, "");
  let wsOrigin: string;
  if (/^https:\/\//i.test(withoutSlash)) {
    wsOrigin = withoutSlash.replace(/^https:\/\//i, "wss://");
  } else if (/^http:\/\//i.test(withoutSlash)) {
    wsOrigin = withoutSlash.replace(/^http:\/\//i, "ws://");
  } else if (/^wss?:\/\//i.test(withoutSlash)) {
    wsOrigin = withoutSlash;
  } else {
    wsOrigin = `wss://${withoutSlash}`;
  }
  return `${wsOrigin}/ws/notification?user_uuid=${encodeURIComponent(userUuid)}`;
}

export function NotificationBell({ canReadContracts = false }: { canReadContracts?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState("");
  const [contractOffset, setContractOffset] = React.useState(0);
  const container = React.useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const profile = useGetMe();
  const userUuid = profile.data?.uuid;

  const notifications = useGetMyNotifications(
    { limit: 30, offset: 0, status: "all" },
    {
      query: {
        queryKey: getGetMyNotificationsQueryKey({
          limit: 30,
          offset: 0,
          status: "all",
        }),
        refetchOnWindowFocus: "always",
      },
    },
  );
  const markRead = useMarkNotificationsRead();
  const contractParams = { limit: CONTRACT_PAGE_SIZE, offset: contractOffset };
  const contracts = useListSigningNotifications(contractParams, {
    query: {
      queryKey: getListSigningNotificationsQueryKey(contractParams),
      enabled: canReadContracts,
      refetchOnWindowFocus: "always",
    },
  });
  const readContract = useReadSigningNotification();
  const readAllContracts = useReadAllSigningNotifications();
  const lkItems = notifications.data?.items ?? [];
  const contractItems = canReadContracts ? contracts.data?.items ?? [] : [];
  const items = [
    ...lkItems.map((item) => ({ source: "lk" as const, item })),
    ...contractItems.map((item) => ({ source: "contract" as const, item })),
  ].sort((a, b) => (b.item.createdAt ?? "").localeCompare(a.item.createdAt ?? ""));
  const contractTotal = canReadContracts ? contracts.data?.total ?? 0 : 0;
  const unread = (notifications.data?.unreadCount ?? 0) + contractTotal;
  const pending = markRead.isPending || readContract.isPending || readAllContracts.isPending;

  const refresh = React.useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: getGetMyNotificationsQueryKey() }),
      client.invalidateQueries({ queryKey: getListSigningNotificationsQueryKey() }),
    ]);
  }, [client]);

  // WebSocket connection to LK notifications
  React.useEffect(() => {
    const targetUserUuid = userUuid;
    if (!targetUserUuid || typeof WebSocket === "undefined") return;

    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let isReconnecting = false;
    let isDisposed = false;

    function connect() {
      if (isDisposed || !targetUserUuid) return;
      try {
        const url = getLkNotificationWsUrl(targetUserUuid);
        ws = new WebSocket(url);

        ws.onopen = () => {
          if (isReconnecting) {
            void refresh();
          }
          isReconnecting = false;
        };

        ws.onmessage = () => {
          void refresh();
        };

        ws.onclose = () => {
          if (isDisposed) return;
          isReconnecting = true;
          reconnectTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          if (ws) {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          }
        };
      } catch {
        if (!isDisposed) {
          isReconnecting = true;
          reconnectTimeout = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    return () => {
      isDisposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    };
  }, [userUuid, refresh]);

  // When opening dropdown, perform fresh refetch of both sources
  React.useEffect(() => {
    if (open) {
      void notifications.refetch();
      if (canReadContracts) {
        void contracts.refetch();
      }
    }
  }, [open, canReadContracts]);

  React.useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  async function markAllRead() {
    setError("");
    try {
      const results = await Promise.allSettled([
        ...(notifications.data?.unreadCount ? [markRead.mutateAsync({ data: { all: true } })] : []),
        ...(contractTotal ? [readAllContracts.mutateAsync()] : []),
      ]);
      await refresh();
      if (results.some((result) => result.status === "rejected")) throw new Error("read failed");
      setContractOffset(0);
    } catch {
      setError("Не удалось отметить уведомления. Повторите попытку.");
    }
  }

  async function openNotification(uuid: string, targetUrl?: string, targetType?: string) {
    setError("");
    try {
      await markRead.mutateAsync({ data: { notificationUuids: [uuid] } });
      await refresh();
      setOpen(false);
      if (targetUrl) {
        const url = resolveNotificationTarget(targetUrl, targetType, window.location.origin, lkBaseUrl());
        if (url?.origin === window.location.origin) {
          await navigate({ to: url.pathname as never, search: Object.fromEntries(url.searchParams) as never, hash: url.hash.slice(1) });
        } else if (url) {
          window.location.assign(url.toString());
        }
      }
    } catch {
      setError("Не удалось открыть уведомление. Повторите попытку.");
    }
  }

  async function openContract(id: string, contractId: string) {
    setError("");
    try {
      await readContract.mutateAsync({ id });
      await refresh();
      setOpen(false);
      await navigate({ to: "/signing", search: { contractId } });
    } catch {
      setError("Не удалось открыть уведомление. Повторите попытку.");
    }
  }

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        aria-label={unread ? `Уведомления: ${unread} непрочитанных` : "Уведомления"}
        aria-expanded={open}
        aria-controls="notifications-panel"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)] hover:bg-[var(--border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      >
        <Bell size={18} aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--primary)] px-1 text-center text-[10px] font-bold text-[var(--primary-foreground)]">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <section
          id="notifications-panel"
          aria-label="Уведомления"
          className="absolute right-0 top-12 z-40 max-h-[min(65dvh,560px)] w-[min(400px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-lg"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] p-4">
            <h2 className="font-semibold">Уведомления</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={pending}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--primary)] hover:underline disabled:opacity-60"
              >
                <CheckCheck size={15} aria-hidden="true" />
                Прочитать все
              </button>
            )}
          </div>
          {(notifications.isPending || (canReadContracts && contracts.isPending)) && <p role="status" className="p-4 text-sm text-[var(--muted-foreground)]">Загрузка уведомлений…</p>}
          {notifications.isError && (
            <button
              type="button"
              onClick={() => void notifications.refetch()}
              className="p-4 text-left text-sm text-[var(--primary)] hover:underline"
            >
              Не удалось загрузить уведомления. Повторить
            </button>
          )}
          {canReadContracts && contracts.isError && (
            <button type="button" onClick={() => void contracts.refetch()} className="p-4 text-left text-sm text-[var(--primary)] hover:underline">
              Не удалось загрузить уведомления о договорах. Повторить
            </button>
          )}
          {!notifications.isPending && !notifications.isError && (!canReadContracts || (!contracts.isPending && !contracts.isError)) && items.length === 0 && contractTotal === 0 && contractOffset === 0 && (
            <p className="p-4 text-sm text-[var(--muted-foreground)]">Уведомлений пока нет.</p>
          )}
          {items.length > 0 && (
            <div className="divide-y divide-[var(--border)]">
              {items.map((entry) => entry.source === "contract" ? (
                <button type="button" key={`contract-${entry.item.id}`} disabled={pending} onClick={() => void openContract(entry.item.id, entry.item.contractId)} className={`block w-full p-4 text-left text-sm hover:bg-[var(--muted)] disabled:opacity-60 ${entry.item.readAt ? "" : "bg-[var(--primary-soft)]"}`}>
                  <span className="block">{entry.item.message}</span>
                  <span className="mt-2 block text-xs text-[var(--muted-foreground)]">{formatDateTimeRu(entry.item.createdAt)}</span>
                </button>
              ) : (
                <button
                  type="button"
                  key={`lk-${entry.item.uuid}`}
                  disabled={pending}
                  onClick={() => void openNotification(entry.item.uuid, entry.item.target?.url, entry.item.target?.type)}
                  className={`block w-full p-4 text-left transition-colors hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[var(--primary)] disabled:opacity-60 ${entry.item.readAt ? "" : "bg-[var(--primary-soft)]"}`}
                >
                  <span className="flex items-start gap-3">
                    {entry.item.authorAvatarUrl ? (
                      <img src={entry.item.authorAvatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--muted)] text-xs font-semibold text-[var(--muted-foreground)]">
                        {entry.item.authorName?.trim().slice(0, 1).toLocaleUpperCase("ru-RU") ?? "У"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold leading-snug">{entry.item.title}</span>
                      {entry.item.authorName && <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">{entry.item.authorName}</span>}
                      <span className="mt-2 block whitespace-pre-wrap break-words text-sm leading-relaxed">{entry.item.content}</span>
                      <span className="mt-2 block text-xs text-[var(--muted-foreground)]">{formatDateTimeRu(entry.item.createdAt)}</span>
                      {entry.item.target?.url && <span className="mt-2 block text-xs font-medium text-[var(--primary)]">Открыть →</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {canReadContracts && contracts.data && (contractTotal > CONTRACT_PAGE_SIZE || contractOffset > 0) && (
            <nav aria-label="Страницы уведомлений о договорах" className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] p-3 text-xs">
              <button type="button" disabled={contractOffset === 0 || contracts.isFetching} onClick={() => setContractOffset((offset) => Math.max(0, offset - CONTRACT_PAGE_SIZE))} className="text-[var(--primary)] hover:underline disabled:opacity-50">Назад</button>
              <span aria-live="polite">{contractItems.length ? `${contractOffset + 1}–${contractOffset + contractItems.length} из ${contractTotal}` : "На странице больше нет уведомлений"}</span>
              <button type="button" disabled={contractOffset + contractItems.length >= contractTotal || !contractItems.length || contracts.isFetching} onClick={() => setContractOffset((offset) => offset + CONTRACT_PAGE_SIZE)} className="text-[var(--primary)] hover:underline disabled:opacity-50">Далее</button>
            </nav>
          )}
          {pending && <LoaderCircle aria-label="Обновление уведомлений" size={18} className="m-3 animate-spin text-[var(--muted-foreground)]" />}
          {error && <p role="alert" className="border-t border-[var(--border)] p-3 text-sm text-[var(--destructive)]">{error}</p>}
        </section>
      )}
    </div>
  );
}
