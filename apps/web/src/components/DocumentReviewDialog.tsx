import { useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useGetDocumentInfo, useRetryReviewerDocumentDelivery } from "@edo/api-client";
import { Button, FullScreenDialog, StatusBadge } from "@edo/ui";
import { DocumentReviewWorkspace, type DocumentReviewNavigationState } from "./DocumentReviewWorkspace";
import { PreviousDocumentEditor } from "./PreviousDocumentEditor";
import { ReviewerDocumentUpload } from "./ReviewerDocumentUpload";
import { useLiveDocumentVersion } from "../lib/use-live-document-version";
import { isHistoricVersion } from "../lib/audit-types";
import { candidateError } from "./CandidateForm";

function CandidateDocumentReview({
  candidateId,
  documentId,
  version: requestedVersion,
  chooseVersion,
  onState,
}: {
  candidateId: string;
  documentId: string;
  version?: number;
  chooseVersion: (version: number) => void;
  onState: (state: DocumentReviewNavigationState) => void;
}) {
  const info = useGetDocumentInfo(documentId);
  const resend = useRetryReviewerDocumentDelivery();
  const number = requestedVersion ?? info.data?.currentVersion ?? 0;
  const correctOwner = info.data?.candidateId === candidateId;
  const version = useLiveDocumentVersion(documentId, correctOwner ? number : 0);
  const historic = isHistoricVersion(number, info.data?.currentVersion);
  if (info.isLoading || (correctOwner && version.isLoading))
    return (
      <p role="status" className="p-4">
        Загрузка документа…
      </p>
    );
  if (info.isError || !correctOwner || version.isError)
    return (
      <div role="alert" className="p-4 text-sm">
        Документ недоступен или не принадлежит этому кандидату.{" "}
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
    );
  if (!version.data) return null;
  const numbers = [
    ...new Set([
      info.data!.currentVersion,
      ...info.data!.pendingDeliveryVersions,
      ...(info.data!.returnedVersions?.map((v) => v.version) ?? []),
      number,
    ]),
  ].sort((a, b) => b - a);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto lg:overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm">
        <h2 className="mr-auto font-semibold">{info.data?.title}</h2>
        <StatusBadge status={version.data.status} document />
        <label className="text-xs">
          Версия{" "}
          <select
            aria-label="Версия документа"
            value={number}
            onChange={(event) => chooseVersion(Number(event.target.value))}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1"
          >
            {numbers.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === info.data?.currentVersion ? " — текущая" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(version.data.uploadOrigin === "REVIEWER" || version.data.delivery) && (
        <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-[var(--muted)] p-2 text-sm">
          <span>
            {version.data.delivery?.status === "SENT"
              ? "Сохранён в ERP"
              : ["PENDING", "SENDING"].includes(version.data.delivery?.status ?? "")
                ? "Документ подтверждён. Отправляем в ERP…"
                : version.data.status === "APPROVED"
                  ? "Не удалось сохранить в ERP. Загрузка и поля сохранены в ЭДО."
                  : version.data.job
                    ? "Проверьте результат OCR, сохраните исправления и подтвердите отправку в ERP."
                    : "OCR недоступен. Заполните поля вручную и подтвердите отправку в ERP."}
          </span>
          {version.data.delivery?.status === "REQUIRES_MANUAL" && (
            <>
              {version.data.delivery.errorReason && (
                <span className="font-medium text-[var(--foreground)]">
                  {version.data.delivery.errorReason}
                </span>
              )}
              <Button variant="outline" disabled={resend.isPending} onClick={() => resend.mutate({ candidateId, documentId, version: number }, { onSuccess: () => void version.refetch() })}>Повторить отправку в ERP</Button>
            </>
          )}
          {resend.isError && <span role="alert">{candidateError(resend.error)}</span>}
        </div>
      )}
      {historic && (
        <p role="status" className="shrink-0 rounded-md bg-[var(--muted)] p-2 text-xs">
          Историческая версия {number}. Изменение запрещено.{" "}
          <button
            onClick={() => chooseVersion(info.data!.currentVersion)}
            className="underline"
          >
            Открыть актуальную версию
          </button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <DocumentReviewWorkspace
          key={`${documentId}:${number}`}
          candidateId={candidateId}
          data={version.data}
          readOnly={historic}
          fitContainer
          onNavigationStateChange={onState}
        />
      </div>
    </div>
  );
}

export function DocumentReviewDialog({ candidateId, documentId, previousDocumentId, version, uploading, onClose, chooseVersion, onUploaded }: {
  candidateId: string; documentId?: string; previousDocumentId?: string; version?: number; uploading?: boolean;
  onClose: () => void; chooseVersion: (version: number) => void;
  onUploaded: (documentId: string, version: number) => Promise<void>;
}) {
  const [state, setState] = useState<DocumentReviewNavigationState>({ busy: false, hasUnsavedChanges: false });
  const bypass = useRef(false);
  useBlocker({
    shouldBlockFn: () => !bypass.current && (state.busy || (state.hasUnsavedChanges && !window.confirm("Есть несохранённые изменения. Закрыть без сохранения?"))),
    enableBeforeUnload: state.busy || state.hasUnsavedChanges,
  });
  return <FullScreenDialog title={uploading ? "Загрузка документа" : "Документ кандидата"} onClose={onClose}>
    {uploading ? <ReviewerDocumentUpload candidateId={candidateId} onState={setState} onUploaded={async (id, number) => {
      bypass.current = true;
      try { await onUploaded(id, number); } finally { bypass.current = false; }
    }} /> : previousDocumentId ? <PreviousDocumentEditor key={previousDocumentId} candidateId={candidateId} documentId={previousDocumentId} onState={setState} />
      : documentId ? <CandidateDocumentReview key={`${documentId}:${version}`} candidateId={candidateId} documentId={documentId} version={version} chooseVersion={chooseVersion} onState={setState} /> : null}
  </FullScreenDialog>;
}
