import { useId } from "react";
import {
  useGetCandidateDetails,
  type CandidateDocumentSummaryDto,
  type DocumentVersionDto,
} from "@edo/api-client";
import { Button, StatusBadge } from "@edo/ui";
import { ArrowRight, ChevronDown } from "lucide-react";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]";

export function ReviewDocumentNavigation({
  candidateId,
  documentId,
  currentTitle,
  currentDocument,
  expanded,
  onExpandedChange,
  busy,
  onSelect,
}: {
  candidateId: string;
  documentId: string;
  currentTitle: string;
  currentDocument?: Pick<
    DocumentVersionDto,
    "documentId" | "version" | "status"
  >;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  busy: boolean;
  onSelect: (document: CandidateDocumentSummaryDto) => void;
}) {
  const details = useGetCandidateDetails(candidateId);
  const listId = useId();
  const documents = [...(details.data?.documents ?? [])]
    .map((doc) =>
      doc.id === currentDocument?.documentId &&
      doc.currentVersion === currentDocument.version
        ? { ...doc, status: currentDocument.status }
        : doc,
    )
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title, "ru") || a.id.localeCompare(b.id),
    );
  const active = documents.find((doc) => doc.id === documentId);
  const activeIndex = documents.findIndex((doc) => doc.id === documentId);
  const following = [
    ...documents.slice(activeIndex + 1),
    ...documents.slice(0, Math.max(0, activeIndex)),
  ];
  const next = following.find(
    (doc) => doc.id !== documentId && doc.status === "IN_REVIEW",
  );
  const pendingCount = documents.filter(
    (doc) => doc.status === "IN_REVIEW",
  ).length;

  return (
    <section
      aria-label="Документы сотрудника"
      className="mt-3 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--card)]"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 p-2 sm:p-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => onExpandedChange(!expanded)}
          className={`h-auto min-h-11 min-w-0 justify-start whitespace-normal text-left max-sm:w-full sm:min-h-8 ${focusRing}`}
        >
          <ChevronDown
            size={16}
            aria-hidden
            className={`shrink-0 ${expanded ? "rotate-180" : ""}`}
          />
          Документы сотрудника{details.data ? ` · ${documents.length}` : ""}
        </Button>
        <span className="min-w-0 flex-1 basis-full break-words text-[13px] [overflow-wrap:anywhere] sm:basis-40">
          {active?.title ?? currentTitle}
        </span>
        {details.data && (
          <span className="text-xs text-[var(--muted-foreground)]">
            На проверке: {pendingCount}
          </span>
        )}
        {!details.isError &&
          !details.isLoading &&
          (next ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onSelect(next)}
              className={`h-auto min-h-11 whitespace-normal sm:min-h-8 ${focusRing}`}
            >
              Следующий на проверке{" "}
              <ArrowRight size={16} aria-hidden className="shrink-0" />
            </Button>
          ) : (
            <span className="text-xs text-[var(--muted-foreground)]">
              Других документов на проверке нет
            </span>
          ))}
      </div>
      {details.isLoading && (
        <p
          role="status"
          className="px-3 pb-3 text-[13px] text-[var(--muted-foreground)]"
        >
          Загрузка списка документов…
        </p>
      )}
      {details.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 px-3 pb-3 text-[13px]"
        >
          Не удалось загрузить список документов.
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={focusRing}
            onClick={() => void details.refetch()}
          >
            Повторить
          </Button>
        </div>
      )}
      <div id={listId} hidden={!expanded}>
        {expanded &&
          details.data &&
          (documents.length ? (
            <ul className="grid max-h-[min(18rem,40dvh)] grid-cols-1 gap-1 overflow-y-auto border-t border-[var(--border)] p-2 sm:grid-cols-2 xl:grid-cols-3">
              {documents.map((doc) => (
                <li key={doc.id} className="min-w-0">
                  <button
                    type="button"
                    aria-current={doc.id === documentId ? "page" : undefined}
                    disabled={busy || details.isError}
                    onClick={() => onSelect(doc)}
                    className={`flex h-full min-h-11 w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left hover:bg-[var(--muted)] disabled:opacity-50 focus-visible:-outline-offset-2 ${focusRing} ${doc.id === documentId ? "bg-[var(--primary-soft)]" : ""}`}
                  >
                    <span className="min-w-0 flex-1 basis-32 break-words [overflow-wrap:anywhere]">
                      <span className="block text-[13px] font-semibold">
                        {doc.title}
                      </span>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        Версия {doc.currentVersion}
                      </span>
                    </span>
                    <StatusBadge status={doc.status} document />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-[var(--border)] p-3 text-[13px] text-[var(--muted-foreground)]">
              Загруженных документов нет.
            </p>
          ))}
      </div>
    </section>
  );
}
