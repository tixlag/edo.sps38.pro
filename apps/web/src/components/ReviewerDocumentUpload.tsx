import { useEffect, useRef, useState } from "react";
import { Button } from "@edo/ui";
import {
  useListReviewerCandidateDocumentTypes,
  useUploadReviewerCandidateDocument,
  useGetCandidateDetails,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { useDocumentInstanceLabel } from "./DocumentInstanceCaption";
import { candidateError } from "./CandidateForm";
import type { DocumentReviewNavigationState } from "./DocumentReviewWorkspace";

function InstanceOption({
  document,
  index,
}: {
  document: CandidateDocumentSummaryDto;
  index: number;
}) {
  const label = useDocumentInstanceLabel(document, index);
  return <option value={document.id}>{label}</option>;
}

export function ReviewerDocumentUpload({
  candidateId,
  onUploaded,
  onState,
}: {
  candidateId: string;
  onUploaded: (documentId: string, version: number) => Promise<void>;
  onState: (state: DocumentReviewNavigationState) => void;
}) {
  const catalog = useListReviewerCandidateDocumentTypes(candidateId);
  const upload = useUploadReviewerCandidateDocument();
  const details = useGetCandidateDetails(candidateId);
  const [mode, setMode] = useState<"new" | "replace" | "append">("replace");
  const [documentId, setDocumentId] = useState("");
  const [code, setCode] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const type = catalog.data?.items.find((item) => item.code === code);
  const instances =
    details.data?.documents.filter(
      (item) => item.documentTypeCode === code && item.status !== "DRAFT",
    ) ?? [];
  const selectedId = instances.some((item) => item.id === documentId)
    ? documentId
    : instances[0]?.id;
  const effectiveMode = instances.length ? mode : "replace";
  const target = instances.find((item) => item.id === selectedId);
  const targetLocked =
    effectiveMode !== "new" && target?.status === "IN_REVIEW";
  const unavailableReason =
    [
      upload.isPending && "Документ загружается…",
      (catalog.isLoading || details.isLoading) &&
        "Загружаем сведения о документах кандидата…",
      catalog.isError &&
        "Для загрузки сначала повторите запрос видов документов.",
      details.isError &&
        "Для загрузки сначала повторите запрос документов кандидата.",
      (!code || !type) && "Выберите вид документа.",
      effectiveMode === "new" &&
        !type?.multipleInstancesAllowed &&
        "Для этого вида можно обновить только существующий документ.",
      targetLocked &&
        "Выбранный документ уже на проверке. Дождитесь решения или выберите другой документ.",
      !files.length && "Выберите файлы документа.",
      files.length > 10 && "Выбрано больше 10 файлов. Уберите лишние файлы.",
      files.some((file) => file.size > 10 * 1024 * 1024) &&
        "Один из файлов больше 10 МиБ. Выберите файл меньшего размера.",
      files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024 &&
        "Общий размер файлов больше 50 МиБ. Уменьшите размер загрузки.",
    ].find(Boolean) || "";
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    onState({ hasUnsavedChanges: files.length > 0, busy: upload.isPending });
  }, [files, upload.isPending, onState]);
  return (
    <form
      className="mx-auto max-w-2xl space-y-5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (unavailableReason) return;
        upload.mutate(
          {
            candidateId,
            data: {
              documentTypeCode: code,
              mode: effectiveMode,
              ...(effectiveMode !== "new" && selectedId
                ? { documentId: selectedId }
                : {}),
              "files[]": files,
              idempotencyKey: key.current,
            },
          },
          {
            onSuccess: (data) => {
              onState({ hasUnsavedChanges: false, busy: false });
              void onUploaded(data.documentId, data.version);
            },
          },
        );
      }}
    >
      <h2 className="text-lg font-semibold">Загрузить документ</h2>
      <p className="text-sm text-[var(--muted-foreground)]">
        После загрузки выполним OCR. Проверьте распознанные поля и подтвердите
        отправку в ERP. Если распознавание недоступно, поля можно заполнить
        вручную.
      </p>
      <label className="block text-sm">
        Вид документа
        <select
          aria-label="Вид документа"
          value={code}
          disabled={upload.isPending}
          onChange={(event) => {
            setCode(event.target.value);
            setDocumentId("");
            setMode("replace");
            key.current = crypto.randomUUID();
          }}
          className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-base"
        >
          <option value="">Выберите вид документа</option>
          {catalog.data?.items.map((type) => (
            <option key={type.code} value={type.code}>
              {type.title}
            </option>
          ))}
        </select>
      </label>
      {catalog.isLoading && <p role="status">Загрузка видов документов…</p>}
      {catalog.isError && (
        <p role="alert">
          Не удалось загрузить виды документов.{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => void catalog.refetch()}
          >
            Повторить
          </Button>
        </p>
      )}
      {details.isError && (
        <div role="alert" className="space-y-2 text-sm text-[var(--danger)]">
          <p>
            Не удалось загрузить сведения о документах кандидата. Повторите
            запрос, чтобы выбрать документ для загрузки.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={details.isFetching}
            onClick={() => void details.refetch()}
          >
            {details.isFetching
              ? "Повторный запрос…"
              : "Повторить запрос документов"}
          </Button>
        </div>
      )}
      {code &&
        !details.isLoading &&
        !details.isError &&
        instances.length > 0 && (
          <div className="space-y-3">
            {instances.length > 1 && (
              <label className="block text-sm">
                Документ
                <select
                  aria-label="Экземпляр документа"
                  value={selectedId}
                  disabled={upload.isPending}
                  className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"
                  onChange={(event) => {
                    setDocumentId(event.target.value);
                    key.current = crypto.randomUUID();
                  }}
                >
                  {instances.map((item, index) => (
                    <InstanceOption
                      key={item.id}
                      document={item}
                      index={index}
                    />
                  ))}
                </select>
              </label>
            )}
            <label className="block text-sm">
              Что хотите сделать?
              <select
                aria-label="Действие с документом"
                className="mt-1 block w-full rounded-lg border border-[var(--border)] bg-[var(--background)] p-3"
                disabled={upload.isPending}
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as "new" | "replace" | "append");
                  key.current = crypto.randomUUID();
                }}
              >
                <option value="append">Добавить страницы</option>
                <option value="replace">Заменить документ</option>
                {type?.multipleInstancesAllowed && (
                  <option value="new">Добавить ещё документ</option>
                )}
              </select>
            </label>
            <p className="text-sm text-[var(--muted-foreground)]">
              {mode === "new"
                ? "Для другого диплома, свидетельства или удостоверения. Он будет проверяться отдельно. Выбранный документ сохранится."
                : mode === "append"
                  ? "Добавьте недостающие страницы того же документа. Они объединятся с уже загруженными в новой версии."
                  : "Новые файлы полностью заменят страницы выбранного документа в новой версии."}
              {type?.multipleInstancesAllowed &&
                mode !== "new" &&
                " Для другого самостоятельного документа выберите «Добавить ещё документ»."}
            </p>
          </div>
        )}
      <label className="block text-sm">
        Файлы документа
        <input
          aria-label="Файлы документа"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif"
          disabled={upload.isPending}
          className="mt-2 block w-full text-base"
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
            key.current = crypto.randomUUID();
          }}
        />
      </label>
      <p className="text-sm text-[var(--muted-foreground)]">
        До 10 файлов, 10 МиБ на файл и 50 МиБ суммарно. Порядок выбранных файлов
        сохраняется.
      </p>
      {!!files.length && (
        <ol className="list-inside list-decimal text-sm">
          {files.map((file, index) => (
            <li key={index}>{file.name}</li>
          ))}
        </ol>
      )}
      {upload.isError && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {candidateError(upload.error)}
        </p>
      )}
      {unavailableReason && (
        <p
          id="reviewer-upload-unavailable"
          role="status"
          className="text-sm text-[var(--muted-foreground)]"
        >
          {unavailableReason}
        </p>
      )}
      <Button
        type="submit"
        aria-describedby={
          unavailableReason ? "reviewer-upload-unavailable" : undefined
        }
        disabled={!!unavailableReason}
      >
        {upload.isPending ? "Загрузка…" : "Загрузить и распознать"}
      </Button>
    </form>
  );
}
