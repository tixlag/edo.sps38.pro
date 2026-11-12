import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getListCommunicationCandidatesQueryKey,
  getListCandidateReviewQueueQueryKey,
  useCreateCandidate,
  useOpenExistingCandidate,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
} from "@edo/api-client";
import {
  CandidateForm,
  candidateError,
  useCandidateRequest,
} from "./CandidateForm";

export function CreateCandidate({ onCancel }: { onCancel: () => void }) {
  const create = useCreateCandidate();
  const open = useOpenExistingCandidate();
  const [openError, setOpenError] = useState("");
  const request = useCandidateRequest();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const confirmed = async (candidate: CandidateWorkspaceDto) => {
    await Promise.all([
      cache.invalidateQueries({
        queryKey: getListCommunicationCandidatesQueryKey(),
      }),
      cache.invalidateQueries({
        queryKey: getListCandidateReviewQueueQueryKey(),
      }),
    ]);
    void navigate({
      to: "/review/candidates/$candidateId",
      params: { candidateId: candidate.id },
      search: { section: "profile" },
    });
  };
  const submit = (
    fields: CandidatePatchFieldsDto,
    personSelection?: string,
    ignoredSelections?: string[],
  ) => {
    const data = {
      requestId: request.requestId,
      fields: {
        ...fields,
        fullName: fields.fullName ?? "",
        phone: fields.phone ?? "",
        birthDate: fields.birthDate ?? "",
      },
      ...(personSelection ? { personSelection } : {}),
      ...(ignoredSelections?.length ? { ignoredSelections } : {}),
    };
    void request.execute(() => create.mutateAsync({ data }), confirmed);
  };
  const openCandidate = async (erpUid: string) => {
    setOpenError("");
    try {
      await confirmed(await open.mutateAsync({ data: { erpUid } }));
    } catch (cause) {
      setOpenError(candidateError(cause));
    }
  };
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 sm:p-6">
      <h2 className="mb-4 text-lg font-semibold">Создать кандидата</h2>
      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        Для создания нужны ФИО, телефон и дата рождения. Если карточка уже есть
        в ERP, откройте её из совпадений. Данные работы и оформления можно
        заполнить позже.
      </p>
      <CandidateForm
        pending={create.isPending || open.isPending || request.checking}
        locked={request.locked}
        retryBlocked={request.blocked}
        error={request.error || openError}
        onSubmit={submit}
        onOpenCandidate={(id) => void openCandidate(id)}
        onCancel={onCancel}
      />
    </section>
  );
}
