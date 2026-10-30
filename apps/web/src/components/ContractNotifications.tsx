import * as React from "react";
import { Bell, LoaderCircle } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSigningNotifications,
  useReadSigningNotification,
  getListSigningNotificationsQueryKey,
} from "@edo/api-client";
import { formatDateTimeRu } from "../lib/date-format";

export function ContractNotifications() {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState("");
  const container = React.useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const client = useQueryClient();
  const notifications = useListSigningNotifications({
    query: {
      queryKey: getListSigningNotificationsQueryKey(),
      refetchInterval: 10_000,
      refetchOnWindowFocus: "always",
    },
  });
  const read = useReadSigningNotification();
  const items = notifications.data?.items ?? [];
  const unread = items.filter((item) => !item.readAt).length;
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
  async function follow(id: string, contractId: string) {
    setError("");
    try {
      await read.mutateAsync({ id });
      await client.invalidateQueries({
        predicate: (query) =>
          String(query.queryKey[0]).includes("contracts/notifications"),
      });
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
        aria-controls="contract-notifications"
        onClick={() => setOpen(!open)}
        className="relative flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)] hover:bg-[var(--border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-[var(--primary)] px-1 text-center text-[10px] font-bold text-[var(--primary-foreground)]">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <section
          id="contract-notifications"
          aria-label="Уведомления о договорах"
          className="absolute right-0 top-12 z-40 max-h-[65dvh] w-[min(360px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-lg"
        >
          <h2 className="border-b border-[var(--border)] p-4 font-semibold">
            Уведомления
          </h2>
          {notifications.isPending ? (
            <p role="status" className="p-4 text-sm">
              Загрузка…
            </p>
          ) : notifications.isError ? (
            <button
              type="button"
              onClick={() => void notifications.refetch()}
              className="p-4 text-left text-sm"
            >
              Не удалось загрузить. Повторить
            </button>
          ) : !items.length ? (
            <p className="p-4 text-sm text-[var(--muted-foreground)]">
              Новых уведомлений пока нет.
            </p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  disabled={read.isPending}
                  onClick={() => void follow(item.id, item.contractId)}
                  className={`block w-full p-4 text-left text-sm hover:bg-[var(--muted)] disabled:opacity-60 ${item.readAt ? "" : "bg-[var(--primary-soft)]"}`}
                >
                  <span className="block">{item.message}</span>
                  <span className="mt-2 block text-xs text-[var(--muted-foreground)]">
                    {formatDateTimeRu(item.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {read.isPending && (
            <LoaderCircle
              aria-label="Открытие уведомления"
              size={18}
              className="m-4 animate-spin"
            />
          )}
          {error && (
            <p role="alert" className="p-4 text-sm">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
