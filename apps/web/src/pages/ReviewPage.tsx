import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import {
  useListReviewDocuments,
  useGetDocumentInfo,
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
} from "@edo/api-client";
import { PageHeader, Card, CardContent, Button, StatusBadge } from "@edo/ui";
import { Clock, Check, X } from "lucide-react";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";

export function ReviewPage() {
  const [tab, setTab] = useState<"IN_REVIEW" | "ERP_PENDING">("IN_REVIEW");
  const [cursor, setCursor] = useState<string | undefined>();
  const list = useListReviewDocuments({ status: tab, limit: 50, cursor });
  return (
    <div className="h-full overflow-auto p-7">
      <PageHeader
        title="Проверка документов"
        subtitle="Документы кандидатов и сотрудников"
      />
      <div className="my-5 flex gap-2">
        <Button
          variant={tab === "IN_REVIEW" ? "default" : "outline"}
          onClick={() => {
            setTab("IN_REVIEW");
            setCursor(undefined);
          }}
        >
          Ожидают проверки
        </Button>
        <Button
          variant={tab === "ERP_PENDING" ? "default" : "outline"}
          onClick={() => {
            setTab("ERP_PENDING");
            setCursor(undefined);
          }}
        >
          Требуют отправки в ERP
        </Button>
      </div>
      {list.isLoading && <p role="status">Загрузка документов…</p>}
      {list.isError && (
        <div role="alert">
          Не удалось загрузить очередь.{" "}
          <Button variant="outline" onClick={() => void list.refetch()}>
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
                  : "Документов для ручной отправки нет."}
              </p>
            )}
            <ul className="divide-y divide-[var(--border)]">
              {list.data.items.map((doc) => (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div>
                    <Link
                      to="/review/$documentId"
                      params={{ documentId: doc.id }}
                      className="font-semibold underline-offset-4 hover:underline"
                    >
                      {doc.title}
                    </Link>
                    <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                      {doc.code1c
                        ? `Сотрудник ${doc.code1c}`
                        : `Чат ${doc.chatUuid ?? "—"}`}{" "}
                      · Версия {doc.currentVersion}
                    </p>
                    {tab === "ERP_PENDING" && (
                      <p className="mt-1 text-sm text-[var(--destructive)]">
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
                variant="outline"
                onClick={() => setCursor(list.data!.nextCursor ?? undefined)}
              >
                Следующая страница
              </Button>
            )}
            {cursor && (
              <Button variant="ghost" onClick={() => setCursor(undefined)}>
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
  const info = useGetDocumentInfo(documentId);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const number =
    selectedVersion ??
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
  return (
    <div className="h-full overflow-auto p-7">
      <Link to="/review" className="mb-4 inline-block text-sm underline">
        Очередь проверки
      </Link>
      <PageHeader
        title={info.data?.title ?? "Проверка документа"}
        subtitle={
          info.data?.code1c
            ? `Сотрудник ${info.data.code1c}`
            : `Чат ${info.data?.chatUuid ?? ""}`
        }
      />
      {info.data &&
        info.data.pendingDeliveryVersions.some(
          (v) => v !== info.data!.currentVersion,
        ) && (
          <label className="mt-4 flex items-center gap-3 text-sm">
            Версия документа
            <select
              className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2"
              value={number}
              onChange={(event) =>
                setSelectedVersion(Number(event.target.value))
              }
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
          <Button
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
        <Card className="mt-5">
          <CardContent>
            <div className="mb-5">
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
            <DocumentReviewWorkspace data={version.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
