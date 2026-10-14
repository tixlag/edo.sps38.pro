import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  useListReviewDocuments,
  useGetDocumentInfo,
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
} from "@edo/api-client";
import { PageHeader, Card, CardContent, Button, StatusBadge } from "@edo/ui";
import { Clock, Check, X } from "lucide-react";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";

const VERSION_STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: "на проверке",
  APPROVED: "подтверждена",
  RETURNED: "возвращена",
};

export function ReviewPage() {
  const [tab, setTab] = useState<"IN_REVIEW" | "ERP_PENDING" | "RETURNED">("IN_REVIEW");
  const [cursor, setCursor] = useState<string | undefined>();
  const list = useListReviewDocuments({ status: tab, limit: 50, cursor });
  const pickTab = (next: typeof tab) => {
    setTab(next);
    setCursor(undefined);
  };
  return (
    <div className="h-full overflow-auto p-7">
      <PageHeader
        title="Проверка документов"
        subtitle="Документы кандидатов и сотрудников"
      />
      <div className="my-4 flex gap-2">
        <Button
          size="sm"
          variant={tab === "IN_REVIEW" ? "default" : "outline"}
          onClick={() => pickTab("IN_REVIEW")}
        >
          Ожидают проверки
        </Button>
        <Button
          size="sm"
          variant={tab === "RETURNED" ? "default" : "outline"}
          onClick={() => pickTab("RETURNED")}
        >
          Возвращённые
        </Button>
        <Button
          size="sm"
          variant={tab === "ERP_PENDING" ? "default" : "outline"}
          onClick={() => pickTab("ERP_PENDING")}
        >
          Требуют отправки в ERP
        </Button>
      </div>
      {list.isLoading && <p role="status">Загрузка документов…</p>}
      {list.isError && (
        <div role="alert">
          Не удалось загрузить очередь.{" "}
          <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
            Повторить
          </Button>
        </div>
      )}
      {list.data && (
        <Card>
          <CardContent>
            {!list.data.items.length && (
              <p className="py-8 text-[var(--muted-foreground)]">
                {tab === "IN_REVIEW"
                  ? "Все документы проверены."
                  : tab === "RETURNED"
                    ? "Возвращённых документов нет."
                    : "Документов для ручной отправки нет."}
              </p>
            )}
            <ul className="divide-y divide-[var(--border)]">
              {list.data.items.map((doc) => (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div>
                    <Link
                      to="/review/$documentId"
                      params={{ documentId: doc.id }}
                      search={{ version: doc.currentVersion }}
                      className="text-[13px] font-semibold underline-offset-4 hover:underline"
                    >
                      {doc.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                      {doc.code1c
                        ? `Сотрудник ${doc.code1c}`
                        : `Чат ${doc.chatUuid ?? "—"}`}{" "}
                      · Версия {doc.currentVersion}
                    </p>
                    {tab === "ERP_PENDING" && (
                      <p className="mt-0.5 text-xs text-[var(--destructive)]">
                        Ожидают отправки версии:{" "}
                        {doc.pendingDeliveryVersions.join(", ")}
                      </p>
                    )}
                  </div>
                  <StatusBadge
                    status={doc.status}
                    document
                    icon={
                      doc.status === "IN_REVIEW" ? (
                        <Clock size={14} />
                      ) : doc.status === "APPROVED" ? (
                        <Check size={14} />
                      ) : (
                        <X size={14} />
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            {list.data.nextCursor && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCursor(list.data!.nextCursor ?? undefined)}
              >
                Следующая страница
              </Button>
            )}
            {cursor && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCursor(undefined)}
              >
                В начало списка
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
export function ReviewDocumentPage() {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const navigate = useNavigate();
  // Versioned deep link from history: /review/$documentId?version=N.
  // useSearch (no route validateSearch change needed): invalid values fall
  // back to the current version with an explicit notice.
  const search = useSearch({ strict: false }) as { version?: unknown };
  const urlVersion = parseVersionParam(search.version);
  const info = useGetDocumentInfo(documentId);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  // URL is the source of truth for deep links; a local override covers the
  // gap between dropdown pick and navigation commit, and resets whenever the
  // URL version changes (back/forward stays consistent).
  useEffect(() => {
    setSelectedVersion(undefined);
  }, [urlVersion, documentId]);
  const currentVersion = info.data?.currentVersion;
  const number =
    selectedVersion ??
    urlVersion ??
    (info.data?.status === "IN_REVIEW"
      ? info.data.currentVersion
      : (info.data?.pendingDeliveryVersions[0] ??
        info.data?.currentVersion ??
        0));
  const version = useGetDocumentVersion(documentId, number, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, number),
      enabled: !!number,
    },
  });
  const historic = isHistoricVersion(version.data?.version, currentVersion);
  const unknownVersionFallback = urlVersion === undefined;
  const chooseVersion = (next: number) => {
    setSelectedVersion(next);
    void navigate({
      to: "/review/$documentId",
      params: { documentId },
      search: { version: next },
    });
  };
  const goToCurrent = () => {
    if (!currentVersion) return;
    chooseVersion(currentVersion);
  };
  const viewedStatus = version.data
    ? (VERSION_STATUS_LABEL[version.data.status] ?? version.data.status)
    : "";
  const decidedAt = version.data?.approvedAt
    ? new Date(version.data.approvedAt).toLocaleString("ru-RU")
    : null;
  return (
    <div className="h-full overflow-auto p-7">
      <Link
        to="/review"
        className="mb-2 inline-block text-[13px] text-[var(--muted-foreground)] underline underline-offset-4 hover:text-[var(--foreground)]"
      >
        ← Очередь проверки
      </Link>
      <PageHeader
        title={info.data?.title ?? "Проверка документа"}
        subtitle={
          info.data?.code1c
            ? `Сотрудник ${info.data.code1c}`
            : `Чат ${info.data?.chatUuid ?? ""}`
        }
      />
      {historic && version.data && (
        <div
          role="status"
          className="mt-3 rounded-[10px] border border-[var(--border)] bg-[var(--primary-soft)] p-3 text-[13px]"
        >
          <p className="font-semibold">
            Историческая версия {version.data.version}
            {currentVersion ? ` (текущая — ${currentVersion})` : ""}. Изменение
            запрещено.
          </p>
          <p className="mt-1">
            Версия от {decidedAt ?? "дата неизвестна"} · статус: {viewedStatus}
            {version.data.rejectionReason
              ? ` · причина: ${version.data.rejectionReason}`
              : ""}
          </p>
          <p className="mt-1">
            Подтверждение, отклонение, исправление полей и отправка в ERP
            доступны только для актуальной версии.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={!currentVersion}
            onClick={goToCurrent}
          >
            Перейти к актуальной версии
          </Button>
        </div>
      )}
      {!historic && unknownVersionFallback && !info.isLoading && currentVersion ? (
        <p
          role="status"
          className="mt-3 rounded-[10px] bg-[var(--muted)] p-3 text-[13px]"
        >
          Точная версия неизвестна (ссылка без версии) — показана текущая
          версия {currentVersion}.
        </p>
      ) : null}
      {info.data &&
        info.data.pendingDeliveryVersions.some(
          (v) => v !== info.data!.currentVersion,
        ) && (
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            Версия документа
            <select
              className="rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px]"
              value={number}
              onChange={(event) => chooseVersion(Number(event.target.value))}
            >
              {[
                ...new Set([
                  info.data.currentVersion,
                  ...info.data.pendingDeliveryVersions,
                ]),
              ].map((v) => (
                <option key={v} value={v}>
                  {v}
                  {info.data!.pendingDeliveryVersions.includes(v)
                    ? " — требует отправки в ERP"
                    : " — текущая"}
                </option>
              ))}
            </select>
          </label>
        )}
      {(info.isLoading || version.isLoading) && (
        <p role="status" className="py-6">
          Загрузка документа…
        </p>
      )}
      {(info.isError || version.isError) && (
        <div role="alert" className="py-6">
          Не удалось загрузить документ.{" "}
          {urlVersion !== undefined && (
            <span>
              Запрошенная версия {urlVersion} недоступна (удалена или не
              существует).{" "}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void info.refetch();
              void version.refetch();
            }}
          >
            Повторить
          </Button>
        </div>
      )}
      {version.data && (
        <Card className="mt-4">
          <CardContent className="p-4">
            <div className="mb-3">
              <StatusBadge
                status={version.data.status}
                document
                icon={
                  version.data.status === "IN_REVIEW" ? (
                    <Clock size={14} />
                  ) : version.data.status === "APPROVED" ? (
                    <Check size={14} />
                  ) : (
                    <X size={14} />
                  )
                }
              />
            </div>
            {/*
              Historic lock without touching DocumentReviewWorkspace (agent E):
              a disabled fieldset disables every nested control (edit inputs,
              save/approve/reject/send buttons) while the banner above explains
              why. The backend also rejects non-current mutations with 409
              (doc.currentVersion check), so this is UX-level enforcement.
              DocumentPreview below keeps using data.version (the requested
              one, never current): cleaned-up rejected originals surface
              honestly as "Оригиналы недоступны" + preview error, never as
              another version's file.
            */}
            {historic ? (
              <fieldset
                disabled
                className="m-0 min-w-0 border-0 p-0"
                aria-label="Историческая версия: изменение запрещено"
              >
                <DocumentReviewWorkspace data={version.data} />
              </fieldset>
            ) : (
              <DocumentReviewWorkspace data={version.data} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
