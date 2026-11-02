import type {
  CandidateDocumentSummaryDto,
  CandidateStageDocumentsDto,
  MissingDocumentTypeDto,
} from "@edo/api-client";
import { Badge, StatusBadge } from "@edo/ui";
import { ChevronRight } from "lucide-react";

export function CandidateDocumentList({
  groups,
  documents,
  missingDocuments = [],
  selectedId,
  stage,
  onOpen,
}: {
  groups?: CandidateStageDocumentsDto | null;
  documents: CandidateDocumentSummaryDto[];
  missingDocuments?: MissingDocumentTypeDto[];
  selectedId?: string;
  stage?: string;
  onOpen: (document: CandidateDocumentSummaryDto, version?: number) => void;
}) {
  const ordered = (items: CandidateDocumentSummaryDto[]) =>
    [...items]
      .filter((item) => !stage || item.status !== "DRAFT")
      .sort((a, b) => a.title.localeCompare(b.title, "ru"));
  const sections = groups
    ? [
        {
          label: "Обязательные",
          documents: ordered(groups.required.documents),
          missing: groups.required.missingDocuments,
        },
        {
          label: "Дополнительные",
          documents: ordered(groups.additional.documents),
          missing: groups.additional.missingDocuments,
        },
      ]
    : [
        {
          label: "Документы",
          documents: ordered(documents),
          missing: missingDocuments,
        },
      ];
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.label} aria-label={section.label}>
          <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
            <h3 className="text-xs font-semibold text-[var(--foreground)]">
              {section.label}
            </h3>
            <span className="text-xs text-[var(--muted-foreground)]">
              {section.documents.length + section.missing.length}
            </span>
          </div>
          {section.documents.length + section.missing.length === 0 ? (
            <p className="px-1 text-xs text-[var(--muted-foreground)]">
              Документов нет.
            </p>
          ) : (
            <ul className="space-y-2">
              {section.documents.map((document) => (
                <li
                  key={document.id}
                  className={`overflow-hidden rounded-lg border bg-[var(--card)] ${selectedId === document.id ? "border-[var(--primary)] bg-[var(--primary-soft)]" : "border-[var(--border)]"}`}
                >
                  <button
                    type="button"
                    aria-label={`${document.title}, версия ${document.currentVersion}`}
                    aria-current={
                      selectedId === document.id ? "true" : undefined
                    }
                    onClick={() => onOpen(document)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]"
                  >
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="block break-words text-[13px] font-semibold">
                        {document.title}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={document.status} document />
                        <span className="text-xs text-[var(--muted-foreground)]">
                          Версия {document.currentVersion}
                        </span>
                      </span>
                    </span>
                    <ChevronRight
                      size={16}
                      aria-hidden
                      className="shrink-0 text-[var(--muted-foreground)]"
                    />
                  </button>
                  {!!document.returnedVersions?.length && (
                    <details className="border-t border-[var(--border)] px-3 py-2 text-xs">
                      <summary className="cursor-pointer text-[var(--muted-foreground)]">
                        Возвращённые версии
                      </summary>
                      {document.returnedVersions.map((returned) => (
                        <button
                          key={returned.version}
                          type="button"
                          className="mt-2 block break-words text-left underline"
                          onClick={() => onOpen(document, returned.version)}
                        >
                          Версия {returned.version}
                          {returned.rejectionReason
                            ? ` · ${returned.rejectionReason}`
                            : ""}
                        </button>
                      ))}
                    </details>
                  )}
                  {!!document.pendingDeliveryVersions.length && (
                    <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
                      Требует отправки в ERP:{" "}
                      {document.pendingDeliveryVersions.map((pending) => (
                        <button
                          key={pending}
                          type="button"
                          className="mr-1 underline"
                          onClick={() => onOpen(document, pending)}
                        >
                          {pending}
                        </button>
                      ))}
                    </p>
                  )}
                </li>
              ))}
              {section.missing.map((item) => (
                <li
                  key={item.code}
                  className="flex items-start justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2.5"
                >
                  <span className="min-w-0 break-words text-[13px] font-medium">
                    {item.title}
                  </span>
                  <Badge className="shrink-0">Не загружен</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
