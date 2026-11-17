import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateDetailsQueryKey,
  getListCandidateDocumentAbsencesQueryKey,
  useDecideCandidateDocumentAbsence,
  useGetMe,
  useListCandidateDocumentAbsences,
  useReportCandidateDocumentAbsence,
  type MissingDocumentTypeDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";

const hasRule = (permissions: Record<string, unknown> | undefined, code: number) =>
  !!permissions && (Object.prototype.hasOwnProperty.call(permissions, String(code)) ||
    Object.prototype.hasOwnProperty.call(permissions, "20009"));

export function CandidateDocumentAbsences({ candidateId, missing }: {
  candidateId: string;
  missing: MissingDocumentTypeDto[];
}) {
  const cache = useQueryClient();
  const me = useGetMe();
  const canReport = hasRule(me.data?.permissions, 20001) || hasRule(me.data?.permissions, 20002);
  const canDecide = hasRule(me.data?.permissions, 20002);
  const absences = useListCandidateDocumentAbsences(candidateId, { query: {
    queryKey: getListCandidateDocumentAbsencesQueryKey(candidateId),
    enabled: canReport || canDecide,
  } });
  const report = useReportCandidateDocumentAbsence();
  const decide = useDecideCandidateDocumentAbsence();
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [decisionComments, setDecisionComments] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const names = new Map(missing.map((item) => [item.code, item.title]));

  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getListCandidateDocumentAbsencesQueryKey(candidateId) }),
      cache.invalidateQueries({ queryKey: getGetCandidateDetailsQueryKey(candidateId) }),
    ]);
  };
  const submit = async (code: string) => {
    if (!reason.trim()) { setError("Укажите причину отсутствия документа."); return; }
    setError(null);
    try {
      await report.mutateAsync({ candidateId, data: { documentTypeCode: code, reason: reason.trim() } });
      setEditingCode(null);
      setReason("");
      await refresh();
    } catch { setError("Не удалось сохранить причину. Повторите попытку."); }
  };
  const decideAbsence = async (absenceId: string, status: "APPROVED" | "REJECTED") => {
    setError(null);
    try {
      await decide.mutateAsync({ candidateId, absenceId, data: { status, comment: decisionComments[absenceId]?.trim() || undefined } });
      setDecisionComments((current) => ({ ...current, [absenceId]: "" }));
      await refresh();
    } catch { setError("Не удалось сохранить решение. Повторите попытку."); }
  };

  if (!canReport && !canDecide && !absences.data?.length) return null;
  return <section aria-label="Отсутствующие документы" className="space-y-3 rounded-lg border border-[var(--border)] p-3">
    <h3 className="text-sm font-semibold">Отсутствующие документы</h3>
    <p className="text-sm text-[var(--muted-foreground)]">
      Если обязательного документа нет, сохраните причину. Отсутствие документа
      можно согласовать или отклонить здесь при наличии права проверки документов.
      Сохранение причины само по себе не снимает требование документа.
    </p>
    {absences.isLoading && <p role="status" className="text-xs">Загрузка решений…</p>}
    {absences.isError && <p role="alert" className="text-xs">Не удалось загрузить решения. <Button size="sm" variant="outline" onClick={() => void absences.refetch()}>Повторить</Button></p>}
    {absences.data?.map((item) => <div key={item.id} className="space-y-1 border-t border-[var(--border)] pt-2 text-sm">
      <p><strong>{item.documentTypeTitle || names.get(item.documentTypeCode) || item.documentTypeCode}</strong> · {item.status === "APPROVED" ? "Исключение согласовано" : item.status === "REJECTED" ? "Исключение отклонено" : "Ожидает решения"}</p>
      <p>Причина: {item.reason}</p>
      {item.decisionComment && <p>Комментарий: {item.decisionComment}</p>}
      {item.decidedBy && <p className="text-xs text-[var(--muted-foreground)]">Решение: {item.decidedBy}</p>}
      {canDecide && item.status === "PENDING" && <div className="space-y-2">
        <label className="block text-xs">Комментарий к решению
          <textarea className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2" value={decisionComments[item.id] ?? ""} onChange={(event) => setDecisionComments((current) => ({ ...current, [item.id]: event.target.value }))} />
        </label>
        <div className="flex gap-2"><Button size="sm" disabled={decide.isPending} onClick={() => void decideAbsence(item.id, "APPROVED")}>Согласовать</Button><Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => void decideAbsence(item.id, "REJECTED")}>Отклонить</Button></div>
      </div>}
    </div>)}
    {canReport && !absences.isLoading && !absences.isError && missing.filter((item) => !absences.data?.some((absence) => absence.documentTypeCode === item.code && absence.status !== "REJECTED")).map((item) => <div key={item.code} className="space-y-2 border-t border-[var(--border)] pt-2 text-sm">
      <span>{item.title}</span>{" "}<Button size="sm" variant="outline" onClick={() => { setEditingCode(editingCode === item.code ? null : item.code); setReason(""); setError(null); }}>Документа нет</Button>
      {editingCode === item.code && <div className="space-y-2"><label className="block text-xs">Причина отсутствия
        <textarea required className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--background)] p-2" value={reason} onChange={(event) => setReason(event.target.value)} />
      </label><Button size="sm" disabled={report.isPending} onClick={() => void submit(item.code)}>Сохранить причину</Button></div>}
    </div>)}
    {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}
  </section>;
}
