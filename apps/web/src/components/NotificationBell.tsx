import * as React from "react";
import { Bell, LoaderCircle, CheckCheck, X } from "lucide-react";
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
import { formatNotificationDateTime } from "../lib/date-format";
import { lkBaseUrl } from "../lib/review-groups";
import { NotificationAvatar } from "./NotificationAvatar";

const CONTRACT_PAGE_SIZE = 30;

export function resolveNotificationTarget(
  targetUrl: string,
  targetType: string | undefined,
  currentOrigin: string,
  lkOrigin: string,
): URL | null {
  if (targetUrl.startsWith("//")) return null;
  try {
    const isEdo =
      targetType === "document_expiration" ||
      targetType === "signing_contract" ||
      targetType === "candidate_document_upload" ||
      targetType === "document_upload" ||
      (targetUrl.startsWith("/") &&
        !targetUrl.startsWith("/surveys") &&
        (targetUrl.startsWith("/review") ||
          targetUrl.startsWith("/candidates") ||
          targetUrl.startsWith("/employees") ||
          targetUrl.startsWith("/signing") ||
          targetUrl.startsWith("/my-documents")));
    const base = isEdo
      ? currentOrigin
      : targetType === "surveys_platform"
        ? `${lkOrigin.replace(/\/$/, "")}/surveys/`
        : lkOrigin;
    const path =
      targetType === "surveys_platform" && targetUrl.startsWith("/")
        ? targetUrl.slice(1)
        : targetUrl;
    const url = new URL(path, base);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

export function getLkNotificationWsUrl(userUuid: string): string {
  const wsEnv = (
    typeof import.meta !== "undefined"
      ? (import.meta.env?.VITE_LK_WS_URL as string | undefined)
      : undefined
  )?.trim();

  let wsOrigin: string;
  if (wsEnv) {
    const withoutSlash = wsEnv.replace(/\/+$/, "");
    if (/^https:\/\//i.test(withoutSlash)) {
      wsOrigin = withoutSlash.replace(/^https:\/\//i, "wss://");
    } else if (/^http:\/\//i.test(withoutSlash)) {
      wsOrigin = withoutSlash.replace(/^http:\/\//i, "ws://");
    } else if (/^wss?:\/\//i.test(withoutSlash)) {
      wsOrigin = withoutSlash;
    } else {
      wsOrigin = `wss://${withoutSlash}`;
    }
  } else {
    const raw = (
      (typeof import.meta !== "undefined" &&
        (import.meta.env?.VITE_LK_BASE_URL as string | undefined)) ||
      lkBaseUrl()
    ).trim();
    const withoutSlash = raw.replace(/\/+$/, "");
    try {
      const url = new URL(
        withoutSlash.startsWith("http") ? withoutSlash : `https://${withoutSlash}`,
      );
      // Default production LK WebSocket runs on port 8091
      const isLkProd =
        url.hostname === "lk.sps38.pro" &&
        (!url.port || url.port === "443" || url.port === "80");
      const port = isLkProd ? ":8091" : url.port ? `:${url.port}` : "";
      const scheme = url.protocol === "http:" ? "ws" : "wss";
      wsOrigin = `${scheme}://${url.hostname}${port}`;
    } catch {
      wsOrigin = withoutSlash.replace(/^https?:\/\//i, "wss://");
    }
  }
  return `${wsOrigin}/ws/notification?user_uuid=${encodeURIComponent(userUuid)}`;
}

export function NotificationBell({
  canReadContracts = false,
}: {
  canReadContracts?: boolean;
}) {
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
  ].sort((a, b) =>
    (b.item.createdAt ?? "").localeCompare(a.item.createdAt ?? ""),
  );
  const contractTotal = canReadContracts ? contracts.data?.total ?? 0 : 0;
  const unread = (notifications.data?.unreadCount ?? 0) + contractTotal;
  const pending =
    markRead.isPending || readContract.isPending || readAllContracts.isPending;

  const refresh = React.useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: getGetMyNotificationsQueryKey() }),
      client.invalidateQueries({
        queryKey: getListSigningNotificationsQueryKey(),
      }),
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
        ...(notifications.data?.unreadCount
          ? [markRead.mutateAsync({ data: { all: true } })]
          : []),
        ...(contractTotal ? [readAllContracts.mutateAsync()] : []),
      ]);
      await refresh();
      if (results.some((result) => result.status === "rejected"))
        throw new Error("read failed");
      setContractOffset(0);
    } catch {
      setError("Не удалось отметить уведомления. Повторите попытку.");
    }
  }

  async function openNotification(
    uuid: string,
    targetUrl?: string,
    targetType?: string,
  ) {
    setError("");
    try {
      await markRead.mutateAsync({ data: { notificationUuids: [uuid] } });
      await refresh();
      setOpen(false);
      if (targetUrl) {
        const url = resolveNotificationTarget(
          targetUrl,
          targetType,
          window.location.origin,
          lkBaseUrl(),
        );
        if (url?.origin === window.location.origin) {
          await navigate({
            to: url.pathname as never,
            search: Object.fromEntries(url.searchParams) as never,
            hash: url.hash.slice(1),
          });
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
        aria-label={
          unread ? `Уведомления: ${unread} непрочитанных` : "Уведомления"
        }
        aria-expanded={open}
        aria-controls="notifications-panel"
        onClick={() => setOpen((value) => !value)}
        className="relative flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)] hover:bg-[var(--border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      >
        <Bell size={18} aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <section
          id="notifications-panel"
          aria-label="Уведомления"
          className="absolute right-0 top-12 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-lg border border-stone-200 bg-white shadow-xl"
        >
          {/* Header styled identically to LK NotificationsPanel */}
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
            <span className="text-sm font-semibold text-stone-700">
              Уведомления
            </span>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  disabled={pending}
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
                  title="Отметить все как прочитанные"
                  aria-label="Отметить все как прочитанные"
                >
                  <CheckCheck className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Прочитать все</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="max-h-[min(70vh,560px)] overflow-y-auto p-2">
            {(notifications.isPending ||
              (canReadContracts && contracts.isPending)) && (
              <p
                role="status"
                className="p-4 text-sm text-[var(--muted-foreground)]"
              >
                Загрузка уведомлений…
              </p>
            )}
            {notifications.isError && (
              <button
                type="button"
                onClick={() => void notifications.refetch()}
                className="block w-full p-3 text-left text-xs font-medium text-red-600 hover:underline"
              >
                Не удалось загрузить уведомления. Повторить
              </button>
            )}
            {canReadContracts && contracts.isError && (
              <button
                type="button"
                onClick={() => void contracts.refetch()}
                className="block w-full p-3 text-left text-xs font-medium text-red-600 hover:underline"
              >
                Не удалось загрузить уведомления о договорах. Повторить
              </button>
            )}

            {!notifications.isPending &&
              !notifications.isError &&
              (!canReadContracts ||
                (!contracts.isPending && !contracts.isError)) &&
              items.length === 0 &&
              contractTotal === 0 &&
              contractOffset === 0 && (
                <div className="rounded-md border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
                  <div className="font-medium text-stone-800">
                    Новых непрочитанных уведомлений сейчас нет.
                  </div>
                  <div className="mt-1">
                    Всю историю уведомлений можно посмотреть на странице{" "}
                    <a
                      href={`${lkBaseUrl()}/public/notifications`}
                      className="font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Все уведомления
                    </a>
                    .
                  </div>
                </div>
              )}

            {items.length > 0 && (
              <div className="space-y-2">
                {items.map((entry) => {
                  if (entry.source === "contract") {
                    const isRead = !!entry.item.readAt;
                    return (
                      <button
                        type="button"
                        key={`contract-${entry.item.id}`}
                        disabled={pending}
                        onClick={() =>
                          void openContract(
                            entry.item.id,
                            entry.item.contractId,
                          )
                        }
                        className={`block w-full cursor-pointer rounded-md border border-stone-200 bg-stone-50 p-3 text-left transition-colors hover:bg-stone-100 disabled:opacity-60 ${
                          isRead ? "" : "border-l-4 border-l-red-600 bg-white"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <NotificationAvatar />
                            <div className="truncate text-sm font-semibold text-stone-800">
                              Подписание договора
                            </div>
                          </div>
                        </div>
                        <div className="line-clamp-3 text-xs text-stone-700">
                          {entry.item.message}
                        </div>
                        <div className="mt-2 text-[11px] text-stone-500">
                          {formatNotificationDateTime(entry.item.createdAt)}
                        </div>
                      </button>
                    );
                  }

                  const isRead = !!entry.item.readAt;
                  return (
                    <button
                      type="button"
                      key={`lk-${entry.item.uuid}`}
                      disabled={pending}
                      onClick={() =>
                        void openNotification(
                          entry.item.uuid,
                          entry.item.target?.url,
                          entry.item.target?.type,
                        )
                      }
                      className={`block w-full cursor-pointer rounded-md border border-stone-200 bg-stone-50 p-3 text-left transition-colors hover:bg-stone-100 disabled:opacity-60 ${
                        isRead ? "" : "border-l-4 border-l-red-600 bg-white"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <NotificationAvatar
                            authorAvatarUrl={entry.item.authorAvatarUrl}
                            authorName={entry.item.authorName}
                          />
                          <div className="truncate text-sm font-semibold text-stone-800">
                            {entry.item.title}
                          </div>
                        </div>
                      </div>
                      <div className="line-clamp-3 text-xs text-stone-700">
                        {entry.item.content}
                      </div>
                      <div className="mt-2 text-[11px] text-stone-500">
                        {formatNotificationDateTime(entry.item.createdAt)}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {canReadContracts &&
              contracts.data &&
              (contractTotal > CONTRACT_PAGE_SIZE || contractOffset > 0) && (
                <nav
                  aria-label="Страницы уведомлений о договорах"
                  className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 pt-2 text-xs"
                >
                  <button
                    type="button"
                    disabled={contractOffset === 0 || contracts.isFetching}
                    onClick={() =>
                      setContractOffset((offset) =>
                        Math.max(0, offset - CONTRACT_PAGE_SIZE),
                      )
                    }
                    className="text-stone-600 hover:text-stone-900 hover:underline disabled:opacity-50"
                  >
                    Назад
                  </button>
                  <span aria-live="polite">
                    {contractItems.length
                      ? `${contractOffset + 1}–${contractOffset + contractItems.length} из ${contractTotal}`
                      : "На странице больше нет уведомлений"}
                  </span>
                  <button
                    type="button"
                    disabled={
                      contractOffset + contractItems.length >= contractTotal ||
                      !contractItems.length ||
                      contracts.isFetching
                    }
                    onClick={() =>
                      setContractOffset((offset) => offset + CONTRACT_PAGE_SIZE)
                    }
                    className="text-stone-600 hover:text-stone-900 hover:underline disabled:opacity-50"
                  >
                    Далее
                  </button>
                </nav>
              )}
          </div>

          {/* Footer styled identically to LK NotificationsPanel */}
          <div className="flex items-center justify-between border-t border-stone-100 px-4 py-3">
            <a
              href={`${lkBaseUrl()}/public/notifications`}
              className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
              target="_blank"
              rel="noopener noreferrer"
            >
              Все уведомления
            </a>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={pending}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
              >
                Отметить все прочитанными
              </button>
            )}
          </div>

          {pending && (
            <div className="flex justify-center p-2">
              <LoaderCircle
                aria-label="Обновление уведомлений"
                size={18}
                className="animate-spin text-stone-400"
              />
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="border-t border-stone-100 p-3 text-xs text-red-600"
            >
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
