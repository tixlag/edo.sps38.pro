import { useEffect, useId, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useGetCandidateDetails,
  type CandidateProfileDto,
  type CandidateDocumentSummaryDto,
  type ReturnedDocumentVersionDto,
} from "@edo/api-client";
import { Badge, Button, StatusBadge } from "@edo/ui";
import { ChevronRight, X } from "lucide-react";
import { LkLink } from "./LkLink";
import {
  candidateInitials,
  documentProgressPercent,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
} from "../lib/review-groups";

/**
 * Side drawer with the candidate profile (snapshot from the review queue)
 * and their documents via `useGetCandidateDetails`. The returned tab displays
 * the backend's returned-version history instead of current document versions.
 *
 * Open state lives in the URL (`?candidate=<id>`): the browser back button
 * closes the drawer and the link is shareable. Closes on the cross button,
 * Escape, or backdrop click. Traps focus while open, returns focus to the
 * opener, locks body scroll, and is full-screen on mobile.
 */
export function CandidateDrawer({
  candidateId,
  profile: queueProfile,
  onClose,
  returnedHistory = false,
  stage,
}: {
  candidateId: string;
  profile: CandidateProfileDto | null;
  onClose: () => void;
  returnedHistory?: boolean;
  stage?: string;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const docs = useGetCandidateDetails(
    candidateId,
    stage ? { stage } : undefined,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const profile = docs.data?.candidate ?? queueProfile;
  const fullName = profile?.fullName?.trim() || null;
  const heading = fullName ?? "Профиль кандидата";
  const progressPercent = profile
    ? documentProgressPercent(
        profile.approvedDocuments,
        profile.requiredDocuments,
      )
    : null;
  const makeItems = (documents: CandidateDocumentSummaryDto[]) =>
    [...documents]
      .filter((doc) => !stage || returnedHistory || doc.status !== "DRAFT")
      .sort((a, b) => a.title.localeCompare(b.title, "ru"))
      .flatMap<{
        doc: CandidateDocumentSummaryDto;
        returnedVersion?: ReturnedDocumentVersionDto;
      }>((doc) =>
        returnedHistory
          ? (doc.returnedVersions ?? []).map((returnedVersion) => ({
              doc,
              returnedVersion,
            }))
          : [{ doc }],
      );
  const stageData = docs.data?.stageDocuments;
  const groupData = stage ? stageData : docs.data?.documentGroups;
  const sections = groupData
    ? [
        {
          label: "Обязательные",
          items: makeItems(groupData.required.documents),
          missing: returnedHistory ? [] : groupData.required.missingDocuments,
        },
        {
          label: "Дополнительные",
          items: makeItems(groupData.additional.documents),
          missing: returnedHistory ? [] : groupData.additional.missingDocuments,
        },
      ]
    : stage
      ? []
      : [
          {
            label: "",
            items: makeItems(docs.data?.documents ?? []),
            missing: returnedHistory ? [] : (docs.data?.missingDocuments ?? []),
          },
        ];
  const count = sections.reduce(
    (sum, section) => sum + section.items.length + section.missing.length,
    0,
  );

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      className="candidate-drawer fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden border-0 bg-transparent p-0 text-[var(--foreground)]"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="candidate-drawer-panel absolute right-0 top-0 flex h-full w-full flex-col bg-[var(--card)] shadow-xl sm:max-w-[520px]">
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border)] p-4">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] text-sm font-semibold text-[var(--foreground)]"
          >
            {candidateInitials(fullName)}
          </span>
          <div className="max-h-[30dvh] min-w-0 flex-1 overflow-y-auto">
            <h2
              id={headingId}
              className="break-words text-base font-semibold leading-snug [overflow-wrap:anywhere]"
            >
              {heading}
            </h2>
            {(profile?.citizenship || profile?.isReemployment) && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {profile?.citizenship && (
                  <Badge title="Гражданство">
                    {profile.citizenship.toUpperCase()}
                  </Badge>
                )}
                {profile?.isReemployment === true && (
                  <Badge tone="warning">Повторный найм</Badge>
                )}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Закрыть профиль кандидата"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {!profile && !docs.isLoading && !docs.isError && (
            <p className="border-b border-[var(--border)] px-4 py-3 text-xs text-[var(--muted-foreground)]">
              Данные профиля не заполнены.
            </p>
          )}
          {profile && (
            <div className="border-b border-[var(--border)] px-4 py-3">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted-foreground)]">
                    Дата рождения
                  </dt>
                  <dd className="mt-0.5 break-words">
                    {formatBirthDateRu(profile.birthDate)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted-foreground)]">
                    Должность
                  </dt>
                  <dd className="mt-0.5 break-words [overflow-wrap:anywhere]">
                    {profile.positionName || "—"}
                  </dd>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-[var(--muted-foreground)]">
                    Объект
                  </dt>
                  <dd className="mt-0.5 break-words [overflow-wrap:anywhere]">
                    {formatCandidateObject(
                      profile.projectName,
                      profile.projectCode,
                    ).replace(/^Объект: /, "")}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted-foreground)]">
                    Менеджер
                  </dt>
                  <dd className="mt-0.5 break-words [overflow-wrap:anywhere]">
                    {profile.managerCode1c ? (
                      <LkLink code1c={profile.managerCode1c}>
                        {profile.managerName ?? profile.managerCode1c}
                      </LkLink>
                    ) : (
                      (profile.managerName ?? "—")
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-[var(--muted-foreground)]">
                    Наставник
                  </dt>
                  <dd className="mt-0.5 break-words [overflow-wrap:anywhere]">
                    {profile.mentorCode1c ? (
                      <LkLink code1c={profile.mentorCode1c}>
                        {profile.mentorName ?? profile.mentorCode1c}
                        {profile.mentorPosition
                          ? ` · ${profile.mentorPosition}`
                          : ""}
                      </LkLink>
                    ) : (
                      (profile.mentorName ?? "—")
                    )}
                  </dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge>
                  {formatDocumentProgress(
                    profile.approvedDocuments,
                    profile.requiredDocuments,
                  )}
                </Badge>
                {progressPercent !== null && (
                  <span
                    role="progressbar"
                    aria-label="Прогресс подтверждения документов"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progressPercent}
                    className="h-1 w-24 overflow-hidden rounded-full bg-[var(--muted)]"
                  >
                    <span
                      aria-hidden
                      className="block h-full rounded-full bg-[var(--primary)]"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="p-4">
            <h3 className="mb-2 text-[13px] font-semibold">
              {returnedHistory ? "Возвращённые версии" : "Документы"}
              {stage &&
                ` · ${stage === "none" ? "Без этапа" : `Этап ${stage}`}`}
              {docs.data && (!stage || stageData) ? ` (${count})` : ""}
            </h3>
            {docs.isLoading && <p role="status">Загрузка документов…</p>}
            {docs.isError && (
              <div role="alert">
                Не удалось загрузить документы.{" "}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void docs.refetch()}
                >
                  Повторить
                </Button>
              </div>
            )}
            {docs.data && stage && !stageData && (
              <p
                role="status"
                className="text-sm text-[var(--muted-foreground)]"
              >
                Не удалось определить документы выбранного этапа. Проверьте
                должность кандидата и доступность справочника.
              </p>
            )}
            {!stage && docs.data && !groupData && (
              <p
                role="status"
                className="mb-2 text-xs text-[var(--muted-foreground)]"
              >
                Не удалось разделить документы: проверьте должность кандидата и
                доступность справочника.
              </p>
            )}
            {!stage &&
              !returnedHistory &&
              docs.data?.missingDocuments == null &&
              docs.data && (
                <p className="mb-2 text-xs text-[var(--muted-foreground)]">
                  Не удалось определить список необходимых документов: не
                  указана должность кандидата.
                </p>
              )}
            {docs.data &&
              (!stage || stageData) &&
              sections.map((section) => (
                <section key={section.label || "all"} className="mb-4">
                  {section.label && (
                    <h4 className="mb-2 text-sm font-semibold">
                      {section.label} (
                      {section.items.length + section.missing.length})
                    </h4>
                  )}
                  {section.items.length === 0 &&
                    section.missing.length === 0 && (
                      <p className="mb-2 text-[13px] text-[var(--muted-foreground)]">
                        {returnedHistory
                          ? "Возвращённых версий нет."
                          : "Документов нет."}
                      </p>
                    )}
                  {!returnedHistory && section.missing.length > 0 && (
                    <ul className="mb-2 flex flex-col gap-2">
                      {section.missing.map((type) => (
                        <li
                          key={type.code}
                          className="flex items-center justify-between gap-3 rounded-[8px] border border-[var(--border)] px-3 py-2.5"
                        >
                          <span className="break-words text-[13px] font-semibold">
                            {type.title}
                          </span>
                          <Badge>Не загружен</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  {section.items.length > 0 && (
                    <ul className="flex flex-col gap-2">
                      {section.items.map(({ doc, returnedVersion }) => (
                        <li
                          key={`${doc.id}:${returnedVersion?.version ?? doc.currentVersion}`}
                          className="overflow-hidden rounded-[8px] border border-[var(--border)]"
                        >
                          <button
                            type="button"
                            aria-label={`${doc.title}, ${returnedVersion ? "возвращённая " : ""}версия ${returnedVersion?.version ?? doc.currentVersion}`}
                            onClick={() =>
                              void navigate({
                                to:
                                  docs.data?.candidate?.reviewGroup === "IG"
                                    ? "/review-ig/$documentId"
                                    : "/review/$documentId",
                                params: { documentId: doc.id },
                                search: {
                                  ...search,
                                  version:
                                    returnedVersion?.version ??
                                    doc.currentVersion,
                                },
                              })
                            }
                            className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--muted)]/40"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block break-words text-[13px] font-semibold">
                                {doc.title}
                              </span>
                              <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                                Версия{" "}
                                {returnedVersion?.version ?? doc.currentVersion}
                              </span>
                              {returnedVersion && (
                                <>
                                  <span className="mt-1 block break-words text-[13px] font-normal">
                                    Причина возврата:{" "}
                                    {returnedVersion.rejectionReason ||
                                      "не указана"}
                                  </span>
                                  <span className="mt-1 block text-xs text-[var(--muted-foreground)]">
                                    {returnedVersion.supersededByVersion != null
                                      ? `Уже загружена новая версия №${returnedVersion.supersededByVersion}`
                                      : "Ожидается повторная загрузка"}
                                  </span>
                                </>
                              )}
                            </span>
                            <StatusBadge
                              status={returnedVersion ? "RETURNED" : doc.status}
                              document
                            />
                            <ChevronRight
                              size={16}
                              aria-hidden
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}
