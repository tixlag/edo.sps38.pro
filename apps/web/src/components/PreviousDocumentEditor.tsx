import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@edo/ui";
import { useGetPreviousDocumentDetails, getGetPreviousDocumentDetailsQueryKey, useEditPreviousDocumentFields,
  getGetCandidateDetailsQueryKey, getListCandidateReviewQueueQueryKey, getListCommunicationCandidatesQueryKey } from "@edo/api-client";
import { ApprovedErpDocumentPreview } from "./ApprovedErpDocumentPreview";
import type { DocumentReviewNavigationState } from "./DocumentReviewWorkspace";
import { candidateError } from "./CandidateForm";

export function PreviousDocumentEditor({ candidateId, documentId, onState }: { candidateId: string; documentId: string; onState: (state: DocumentReviewNavigationState) => void }) {
  const query = useGetPreviousDocumentDetails(candidateId, documentId);
  const save = useEditPreviousDocumentFields();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<{ revision: number; fields: Record<string, string | boolean | null> }>();
  const [tab, setTab] = useState("document");
  useEffect(() => { onState({ hasUnsavedChanges: !!draft, busy: save.isPending }); }, [draft, save.isPending, onState]);
  if (query.isLoading) return <p role="status">Загрузка документа и полей…</p>;
  if (!query.data || query.isError) return <div role="alert">Не удалось загрузить документ. <Button variant="outline" onClick={() => void query.refetch()}>Повторить</Button></div>;
  const data = query.data;
  const stale = !!draft && draft.revision !== data.revision;
  return <div className="flex h-full min-h-0 flex-col gap-3">
    <div className="flex gap-2 lg:hidden"><Button variant={tab === "document" ? "default" : "outline"} onClick={() => setTab("document")}>Документ</Button><Button variant={tab === "fields" ? "default" : "outline"} onClick={() => setTab("fields")}>Поля</Button></div>
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      <div className={`min-h-0 min-w-0 flex-1 ${tab !== "document" ? "hidden lg:block" : ""}`}>
        {data.document.originalAvailable ? <ApprovedErpDocumentPreview candidateId={candidateId} document={data.document} /> : <p role="status">Оригинал недоступен. Реквизиты доступны справа.</p>}
      </div>
      <form className={`min-h-0 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 lg:w-[380px] lg:shrink-0 ${tab !== "fields" ? "hidden lg:block" : ""}`}
        onSubmit={(event) => { event.preventDefault(); if (!draft || stale) return;
          save.mutate({ candidateId, documentId, data: draft }, { onSuccess: (updated) => {
            cache.setQueryData(getGetPreviousDocumentDetailsQueryKey(candidateId, documentId), updated);
            setDraft(undefined);
            for (const key of [getGetCandidateDetailsQueryKey(candidateId), getListCandidateReviewQueueQueryKey(), getListCommunicationCandidatesQueryKey()]) void cache.invalidateQueries({ queryKey: key.slice(0, 1) });
          } });
        }}>
        <h2 className="font-semibold">Реквизиты документа</h2>
        <p className="my-3 text-sm text-[var(--muted-foreground)]">Исправления сохраняются только в ЭДО. Исходные поля ERP не изменяются.</p>
        {data.fields.map((field) => {
          const value = draft && Object.hasOwn(draft.fields, field.name) ? draft.fields[field.name] : field.kind === "boolean" ? field.value === "true" : field.value ?? "";
          const change = (value: string | boolean) => setDraft((old) => ({ revision: old?.revision ?? data.revision, fields: { ...old?.fields, [field.name]: value } }));
          return <label key={field.name} className="mb-4 block text-sm"><span className="mb-1 block font-medium">{field.label}</span>
            {field.kind === "boolean" ? <input type="checkbox" checked={value === true || value === "true"} onChange={(event) => change(event.target.checked)} disabled={save.isPending} />
              : <input type={field.kind === "date" ? "date" : "text"} value={String(value ?? "")} disabled={save.isPending} onChange={(event) => change(event.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-base" />}
          </label>;
        })}
        {stale && <p role="alert">Поля изменены другим проверяющим. Закройте документ и откройте заново, чтобы загрузить актуальные данные.</p>}
        {save.isError && <p role="alert" className="my-3 text-sm text-[var(--danger)]">{candidateError(save.error)}</p>}
        {save.isSuccess && !draft && <p role="status" className="my-3 text-sm">Изменения сохранены в ЭДО.</p>}
        <Button type="submit" disabled={!draft || stale || save.isPending}>{save.isPending ? "Сохранение…" : "Сохранить в ЭДО"}</Button>
      </form>
    </div>
  </div>;
}
