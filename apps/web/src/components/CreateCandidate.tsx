import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCommunicationCandidatesQueryKey,
  getListCandidateReviewQueueQueryKey,
  useCreateCandidate,
  type CandidateFieldsDto,
} from "@edo/api-client";
import { CandidateForm, useCandidateRequest } from "./CandidateForm";

export function CreateCandidate({ onCancel }: { onCancel: () => void }) {
  const create = useCreateCandidate();
  const request = useCandidateRequest();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const submit = async (
    fields: CandidateFieldsDto,
    personSelection?: string,
  ) => {
    request.begin();
    try {
      const candidate = await create.mutateAsync({
        data: {
          requestId: request.requestId,
          fields,
          ...(personSelection ? { personSelection } : {}),
        },
      });
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
    } catch (error) {
      request.fail(error);
    }
  };
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 sm:p-6">
      <h2 className="mb-4 text-lg font-semibold">Создать кандидата</h2>
      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        Карточка будет создана в ERP со статусом «Подбор». Чат и объект можно
        добавить позже.
      </p>
      <CandidateForm
        pending={create.isPending}
        locked={request.locked}
        error={request.error}
        onSubmit={(fields, personSelection) =>
          void submit(fields, personSelection)
        }
        onCancel={onCancel}
      />
    </section>
  );
}
