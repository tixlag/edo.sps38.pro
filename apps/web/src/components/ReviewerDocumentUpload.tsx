import { useEffect, useRef, useState } from "react";
import { Button } from "@edo/ui";
import {
  useListReviewerCandidateDocumentTypes,
  useUploadReviewerCandidateDocument,
  useGetCandidateDetails,
} from "@edo/api-client";
import { candidateError } from "./CandidateForm";
import type { DocumentReviewNavigationState } from "./DocumentReviewWorkspace";

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
  const selectedId = documentId || instances[0]?.id;
  const target = instances.find((item) => item.id === selectedId);
  const targetLocked = mode !== "new" && target?.status === "IN_REVIEW";
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    onState({ hasUnsavedChanges: files.length > 0, busy: upload.isPending });
  }, [files, upload.isPending, onState]);
  return (
    <form
      className="mx-auto max-w-2xl space-y-5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !code ||
          !files.length ||
          targetLocked ||
          (mode === "new" && !type?.multipleInstancesAllowed)
        )
          return;
        upload.mutate(
          {
            candidateId,
            data: {
              documentTypeCode: code,
              mode,
              ...(mode !== "new" && selectedId
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
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            Повторить
          </Button>
        </p>
      )}
      {code && (
        <div className="space-y-3">
          <label className="block text-sm">
            Действие
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
              <option value="replace">
                {instances.length
                  ? "Заменить страницы документа"
                  : "Загрузить документ"}
              </option>
              {instances.length > 0 && (
                <option value="append">Добавить страницы к документу</option>
              )}
              {type?.multipleInstancesAllowed && (
                <option value="new">Создать отдельный документ</option>
              )}
            </select>
          </label>
          {mode !== "new" && instances.length > 1 && (
            <label className="block text-sm">
              Экземпляр документа
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
                  <option key={item.id} value={item.id}>
                    Документ {index + 1} · версия {item.currentVersion}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-xs text-[var(--muted-foreground)]">
            {mode === "new"
              ? "Новый документ получит отдельную проверку."
              : mode === "append"
                ? "Новые страницы дополнят выбранный документ и отправятся на проверку."
                : "Файлы заменят страницы в новой версии документа."}
          </p>
          {targetLocked && (
            <p role="status" className="text-sm">
              Выбранный экземпляр уже на проверке. Дождитесь решения.
            </p>
          )}
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
      <p className="text-xs text-[var(--muted-foreground)]">
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
      <Button
        type="submit"
        disabled={
          !code ||
          !files.length ||
          targetLocked ||
          details.isLoading ||
          details.isError ||
          files.length > 10 ||
          files.some((file) => file.size > 10 * 1024 * 1024) ||
          files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024 ||
          upload.isPending
        }
      >
        {upload.isPending ? "Загрузка…" : "Загрузить и распознать"}
      </Button>
    </form>
  );
}
