import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ChatMessageDto,
  type ChatChannel,
  type CommunicationOperationDto,
  useGetCommunicationContext,
  useListCommunicationMessages,
  getListCommunicationMessagesQueryKey,
  getGetCommunicationContextQueryKey,
  useSendCommunicationMessage,
  useUploadCommunicationAttachment,
  useCreateCommunicationLkLink,
  createCommunicationStreamGrant,
  subscribeCommunicationUpdates,
  getCommunicationAttachmentDownload,
  useGetCommunicationOperation,
  getGetCommunicationOperationQueryKey,
} from "@edo/api-client";
import { Badge, Button, EmptyState } from "@edo/ui";
import { Download, Paperclip, Send, X } from "lucide-react";
import {
  chatDraftKey,
  readChatDraft,
  writeChatDraft,
  subscribeChatDraftReset,
  type ChatDraft,
} from "../lib/chat-drafts";

const CHANNEL_LABEL: Record<ChatChannel, string> = {
  lk: "ЛК",
  tg: "Telegram",
  wa: "WhatsApp",
  sms: "SMS",
};

export function CandidateChat({ candidateId }: { candidateId: string }) {
  const context = useGetCommunicationContext(candidateId);
  const cache = useQueryClient();
  const [cursor, setCursor] = useState<string>();
  const history = useListCommunicationMessages(candidateId, {
    limit: 50,
    cursor,
  });
  const latest = useListCommunicationMessages(candidateId, { limit: 50 });
  const [older, setOlder] = useState<ChatMessageDto[]>([]);
  const [recipientId, setRecipientId] = useState("");
  const [state, setState] = useState<
    "connecting" | "connected" | "reconnecting"
  >("connecting");
  const [downloadError, setDownloadError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const first = useRef(true);
  const pendingDownload = useRef(false);
  const recipients = context.data?.recipients ?? [];
  const recipient =
    recipients.find((r) => `${r.channel}:${r.id}` === recipientId) ??
    recipients[0];
  const key = chatDraftKey(
    candidateId,
    recipient?.channel ?? "lk",
    recipient?.id ?? "",
  );
  const [draft, setDraft] = useState<ChatDraft>(() => readChatDraft(key));
  useEffect(() => {
    setDraft(readChatDraft(key));
  }, [key]);
  useEffect(() => subscribeChatDraftReset(() => setDraft({ text: "" })), []);
  const change = (next: ChatDraft) => {
    setDraft(next);
    writeChatDraft(key, next);
  };
  const [notice, setNotice] = useState("");
  const send = useSendCommunicationMessage();
  const upload = useUploadCommunicationAttachment();
  const link = useCreateCommunicationLkLink();
  const receipt = useGetCommunicationOperation(
    candidateId,
    draft.operationId ?? "",
    {
      query: {
        queryKey: getGetCommunicationOperationQueryKey(
          candidateId,
          draft.operationId ?? "",
        ),
        enabled: !!draft.operationId && draft.locked === true,
        refetchInterval: (query) =>
          query.state.data?.status === "PENDING" ? 3000 : false,
      },
    },
  );
  const operation = receipt.data ?? send.data;
  const applyReceipt = (
    result: CommunicationOperationDto,
    targetKey: string,
    sentDraft: ChatDraft,
  ) => {
    if (result.status === "SENT") {
      const cleared = { text: "" };
      writeChatDraft(targetKey, cleared);
      if (targetKey === key) setDraft(cleared);
      setNotice("Сообщение отправлено.");
    } else {
      const updated = {
        ...sentDraft,
        attachment:
          result.status === "FAILED" ? undefined : sentDraft.attachment,
        operationId: result.id,
        locked: result.status === "PENDING" || result.status === "UNKNOWN",
        requestId: result.status === "FAILED" ? undefined : sentDraft.requestId,
      };
      writeChatDraft(targetKey, updated);
      if (targetKey === key) setDraft(updated);
      setNotice(
        result.status === "UNKNOWN"
          ? "Результат отправки неизвестен. Проверьте историю перед новой отправкой."
          : result.status === "FAILED"
            ? "Сообщение не отправлено. Повторите попытку; файл прикрепите заново."
            : "Ожидается подтверждение отправки…",
      );
    }
    void cache.invalidateQueries({
      queryKey: getListCommunicationMessagesQueryKey(candidateId),
    });
  };
  useEffect(() => {
    if (receipt.data && receipt.data.status !== "PENDING" && draft.operationId)
      applyReceipt(receipt.data, key, draft);
    // A terminal receipt changes the local draft once; it must not be reapplied
    // whenever the composer text changes.
  }, [receipt.data]);
  useEffect(() => {
    if (cursor && history.data)
      setOlder((previous) => [
        ...new Map(
          [...previous, ...history.data.items].map((m) => [m.id, m]),
        ).values(),
      ]);
  }, [cursor, history.data]);
  const messages = useMemo(
    () =>
      [
        ...new Map(
          [...older, ...(latest.data?.items ?? [])].map((m) => [m.id, m]),
        ).values(),
      ].sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
          a.id.localeCompare(b.id),
      ),
    [older, latest.data],
  );
  const nextCursor = cursor
    ? history.data?.nextCursor
    : latest.data?.nextCursor;
  useEffect(() => {
    if (first.current || follow.current) {
      bottom.current?.scrollIntoView({ block: "end" });
      first.current = false;
    }
  }, [messages.length]);
  useEffect(
    () =>
      subscribeCommunicationUpdates({
        connect: () => createCommunicationStreamGrant(candidateId),
        onChange: () => {
          void cache.invalidateQueries({
            queryKey: getListCommunicationMessagesQueryKey(candidateId, {
              limit: 50,
            }),
          });
        },
        onState: setState,
      }),
    [candidateId, cache],
  );
  // Polling is a fallback when SSE cannot reconnect. The normal connection
  // pushes LK changes immediately and checks ERP every five seconds.
  useEffect(() => {
    if (state === "connected") return;
    const timer = setInterval(() => {
      void latest.refetch();
    }, 5000);
    return () => clearInterval(timer);
  }, [state, latest.refetch]);
  const busy = send.isPending || upload.isPending || !!draft.locked;
  const submit = () => {
    if (!recipient || busy || (!draft.text.trim() && !draft.attachment)) return;
    const requestId = draft.requestId ?? crypto.randomUUID();
    const sentDraft = { ...draft, requestId, locked: true };
    change(sentDraft);
    setNotice("");
    const targetKey = key;
    send.mutate(
      {
        candidateId,
        data: {
          requestId,
          channel: recipient.channel,
          recipientId: recipient.id,
          text: draft.text,
          attachmentIds: draft.attachment ? [draft.attachment.id] : [],
        },
      },
      {
        onSuccess: (result) => applyReceipt(result, targetKey, sentDraft),
        onError: () => {
          // Keep the same request ID after a transport failure. An explicit retry
          // reads the original receipt instead of dispatching another SMS.
          const retained = { ...sentDraft, locked: false };
          writeChatDraft(targetKey, retained);
          if (targetKey === key) setDraft(retained);
          setNotice(
            "Не удалось получить ответ. Повторите запрос: повторное сообщение не будет отправлено.",
          );
        },
      },
    );
  };
  const download = async (id: string) => {
    if (pendingDownload.current) return;
    pendingDownload.current = true;
    setDownloadError("");
    try {
      const result = await getCommunicationAttachmentDownload(candidateId, {
        attachmentId: id,
      });
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.rel = "noopener noreferrer";
      anchor.click();
    } catch {
      setDownloadError("Не удалось скачать вложение. Повторите попытку.");
    } finally {
      pendingDownload.current = false;
    }
  };
  return (
    <section
      aria-label="Чат кандидата"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Переписка</h2>
        <span role="status" className="text-xs text-[var(--muted-foreground)]">
          {state === "connected"
            ? "Обновляется автоматически"
            : state === "connecting"
              ? "Подключение…"
              : "Переподключение…"}
        </span>
      </div>
      <div
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          if (el)
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4"
      >
        {(latest.isLoading || context.isLoading) && (
          <p role="status" className="text-sm">
            Загрузка переписки…
          </p>
        )}
        {(latest.isError || context.isError) && (
          <div role="alert" className="mb-3 text-sm">
            Не удалось загрузить переписку.{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void latest.refetch();
                void context.refetch();
              }}
            >
              Повторить
            </Button>
          </div>
        )}
        {!![
          ...(latest.data?.unavailableSources ?? []),
          ...(context.data?.unavailableSources ?? []),
        ].length && (
          <p
            role="status"
            className="mb-3 rounded-md bg-[var(--muted)] p-2 text-xs"
          >
            Часть каналов временно недоступна. Показана доступная история.{" "}
            <button
              className="underline"
              onClick={() => {
                void latest.refetch();
                void context.refetch();
              }}
            >
              Повторить загрузку
            </button>
          </p>
        )}
        {history.isError && cursor && (
          <p role="alert" className="mb-2 text-xs">
            Не удалось загрузить предыдущие сообщения.{" "}
            <button
              className="underline"
              onClick={() => void history.refetch()}
            >
              Повторить
            </button>
          </p>
        )}
        {nextCursor && (
          <div className="mb-4 text-center">
            <Button
              size="sm"
              variant="outline"
              disabled={history.isFetching}
              onClick={() => {
                follow.current = false;
                setCursor(nextCursor);
              }}
            >
              Загрузить предыдущие сообщения
            </Button>
          </div>
        )}
        {!latest.isLoading && latest.data && !messages.length && (
          <EmptyState
            title="Переписки пока нет"
            description="Выберите доступный канал, чтобы написать кандидату."
          />
        )}
        <ol className="flex flex-col gap-3" aria-label="Сообщения">
          {messages.map((message) => (
            <li
              key={message.id}
              className={`max-w-[90%] rounded-xl border border-[var(--border)] px-3 py-2 sm:max-w-[82%] ${message.outgoing ? "ml-auto bg-[var(--primary-soft)]" : "mr-auto bg-[var(--background)]"}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
                <Badge>{CHANNEL_LABEL[message.channel]}</Badge>
                <span>{message.author}</span>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleString("ru-RU", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {message.text && (
                <p className="whitespace-pre-wrap break-words text-[13px] [overflow-wrap:anywhere]">
                  {message.text}
                </p>
              )}
              {message.attachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  onClick={() => void download(attachment.id)}
                  className="mt-2 flex max-w-full items-center gap-2 rounded-md border border-[var(--border)] px-2 py-1.5 text-left text-xs hover:bg-[var(--muted)]"
                >
                  <Download size={14} className="shrink-0" />
                  <span className="break-all">{attachment.filename}</span>
                </button>
              ))}
            </li>
          ))}
        </ol>
        {downloadError && (
          <p role="alert" className="mt-2 text-sm">
            {downloadError}
          </p>
        )}
        <div ref={bottom} />
      </div>
      <div className="shrink-0 border-t border-[var(--border)] p-3">
        {context.data?.canSend ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label className="min-w-0 flex-1 text-xs">
                Канал и получатель
                <select
                  aria-label="Канал и получатель"
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-[13px]"
                  disabled={send.isPending || upload.isPending}
                  value={
                    recipient ? `${recipient.channel}:${recipient.id}` : ""
                  }
                  onChange={(event) => {
                    setRecipientId(event.target.value);
                    setNotice("");
                  }}
                >
                  {!recipients.length && (
                    <option value="">Нет доступных каналов</option>
                  )}
                  {recipients.map((r) => (
                    <option
                      key={`${r.channel}:${r.id}`}
                      value={`${r.channel}:${r.id}`}
                    >
                      {CHANNEL_LABEL[r.channel]} · {r.label}
                    </option>
                  ))}
                </select>
              </label>
              {!!context.data.templates.length && (
                <label className="min-w-0 flex-1 text-xs">
                  Шаблон ответа
                  <select
                    aria-label="Шаблон ответа"
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-[13px]"
                    disabled={busy}
                    value=""
                    onChange={(event) => {
                      const template = context.data?.templates.find(
                        (t) => t.id === event.target.value,
                      );
                      if (template)
                        change({
                          ...draft,
                          text: [draft.text, template.text]
                            .filter(Boolean)
                            .join("\n")
                            .slice(0, 16000),
                          requestId: undefined,
                        });
                    }}
                  >
                    <option value="">Выбрать шаблон</option>
                    {context.data.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="sr-only" htmlFor={`chat-message-${candidateId}`}>
              Сообщение кандидату
            </label>
            <textarea
              id={`chat-message-${candidateId}`}
              value={draft.text}
              maxLength={16000}
              rows={3}
              disabled={busy || !recipient}
              onChange={(event) =>
                change({
                  ...draft,
                  text: event.target.value,
                  requestId: undefined,
                })
              }
              placeholder={
                recipient?.channel === "sms"
                  ? "Текст SMS"
                  : "Написать сообщение…"
              }
              className="block max-h-40 min-h-20 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] p-2 text-[13px] caret-[var(--primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            />
            {draft.attachment && (
              <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{draft.attachment.filename}</span>
                <Button
                  aria-label="Убрать вложение"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    change({
                      ...draft,
                      attachment: undefined,
                      requestId: undefined,
                    })
                  }
                >
                  <X size={14} />
                </Button>
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label
                className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs ${!recipient?.supportsFiles || busy || draft.attachment ? "pointer-events-none opacity-50" : "hover:bg-[var(--muted)]"}`}
              >
                <Paperclip size={14} />
                Файл
                <input
                  aria-label="Прикрепить файл"
                  type="file"
                  className="sr-only"
                  disabled={
                    !recipient?.supportsFiles || busy || !!draft.attachment
                  }
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    if (!file.size || file.size > 10 * 1024 * 1024) {
                      setNotice("Выберите файл размером до 10 МБ.");
                      return;
                    }
                    upload.mutate(
                      { candidateId, data: { file } },
                      {
                        onSuccess: (attachment) =>
                          change({
                            ...draft,
                            attachment,
                            requestId: undefined,
                          }),
                        onError: () =>
                          setNotice(
                            "Не удалось загрузить файл. Проверьте формат и повторите.",
                          ),
                      },
                    );
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || link.isPending}
                onClick={() =>
                  link.mutate(
                    { candidateId },
                    {
                      onSuccess: (result) => {
                        change({
                          ...draft,
                          text: [draft.text, result.url]
                            .filter(Boolean)
                            .join("\n")
                            .slice(0, 16000),
                          requestId: undefined,
                        });
                        void cache.invalidateQueries({
                          queryKey:
                            getGetCommunicationContextQueryKey(candidateId),
                        });
                      },
                      onError: () =>
                        setNotice(
                          "Не удалось получить ссылку ЛК. Повторите попытку.",
                        ),
                    },
                  )
                }
              >
                Ссылка ЛК
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                disabled={
                  busy ||
                  !recipient ||
                  (!draft.text.trim() && !draft.attachment)
                }
                onClick={submit}
              >
                <Send size={14} />
                {send.isPending ? "Отправка…" : "Отправить"}
              </Button>
            </div>
            {recipient?.channel === "sms" && (
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                SMS поддерживает только текст.
              </p>
            )}
            {draft.locked && operation?.status === "UNKNOWN" && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void latest.refetch();
                  }}
                >
                  Проверить историю
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    change({ text: "" });
                    setNotice("");
                  }}
                >
                  Начать новое сообщение
                </Button>
              </div>
            )}
          </>
        ) : (
          context.data && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Для отправки нужны право проверки документов и код сотрудника в
              профиле.
            </p>
          )
        )}
        {notice && (
          <p role="status" className="mt-2 text-xs">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
