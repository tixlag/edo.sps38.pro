import {
  useGetCandidateRequirements,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";

export function CandidateRequirements({
  candidateId,
  documents,
}: {
  candidateId: string;
  documents: CandidateDocumentSummaryDto[];
}) {
  const requirements = useGetCandidateRequirements(candidateId);
  if (requirements.isLoading)
    return (
      <p role="status" className="p-2 text-sm">
        Загрузка перечня документов…
      </p>
    );
  if (requirements.isError)
    return (
      <div role="alert" className="space-y-2 p-2 text-sm">
        Не удалось определить необходимые документы. Проверьте должность в
        данных кандидата.
        <Button
          variant="outline"
          size="sm"
          onClick={() => void requirements.refetch()}
        >
          Повторить
        </Button>
      </div>
    );
  const missing =
    requirements.data?.items.filter(
      (item) =>
        !documents.some(
          (document) =>
            document.documentUid === item.documentUid ||
            document.documentTypeCode === item.code,
        ),
    ) ?? [];
  return (
    <section
      aria-label="Необходимые документы"
      className="mb-3 space-y-2 border-b border-[var(--border)] p-2 pb-4"
    >
      <h3 className="text-sm font-semibold">Необходимые документы</h3>
      {!requirements.data?.items.length ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          ERP не задала документы для текущей должности и гражданства.
        </p>
      ) : !missing.length ? (
        <p className="text-xs">
          Все необходимые документы загружены. Актуальность проверяется
          отдельно.
        </p>
      ) : (
        <>
          <p className="text-xs text-[var(--muted-foreground)]">
            Не загружены для текущей должности и гражданства:
          </p>
          <ul className="list-inside list-disc space-y-1 text-xs">
            {missing.map((item) => (
              <li key={item.code}>{item.title}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
