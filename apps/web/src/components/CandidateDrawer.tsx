import { useEffect, useId, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useGetCandidateDetails,
  type CandidateProfileDto,
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
 * and ALL of their documents via `useGetCandidateDetails`.
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
}: {
  candidateId: string;
  profile: CandidateProfileDto | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const docs = useGetCandidateDetails(candidateId);
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
  const items = [...(docs.data?.documents ?? [])].sort((a, b) =>
    a.title.localeCompare(b.title, "ru"),
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
        <div className="flex items-start gap-3 border-b border-[var(--border)] p-4">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--muted)] text-[15px] font-semibold text-[var(--foreground)]"
          >
            {candidateInitials(fullName)}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={headingId}
              className="break-words text-[15px] font-semibold"
            >
              {heading}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-2">
              {profile?.citizenship && (
                <Badge title="Гражданство">
                  {profile.citizenship.toUpperCase()}
                </Badge>
              )}
              {profile?.isReemployment === true && (
                <Badge tone="warning">Повторный найм</Badge>
              )}
            </p>
            {!profile && !docs.isLoading && !docs.isError && (
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                Данные профиля не заполнены.
              </p>
            )}
            {profile && (
              <>
                <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                  <span title="Дата рождения">
                    {formatBirthDateRu(profile.birthDate)}
                  </span>
                  {profile.positionName && (
                    <span title="Должность">{profile.positionName}</span>
                  )}
                  <span title="Объект">
                    {formatCandidateObject(
                      profile.projectName,
                      profile.projectCode,
                    )}
                  </span>
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
                  <span>
                    Менеджер:{" "}
                    {profile.managerCode1c ? (
                      <LkLink code1c={profile.managerCode1c}>
                        {profile.managerName ?? profile.managerCode1c}
                      </LkLink>
                    ) : (
                      (profile.managerName ?? "—")
                    )}
                  </span>
                  <span>
                    Наставник:{" "}
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
                  </span>
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2">
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
                </p>
              </>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Закрыть профиль кандидата"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h3 className="mb-2 text-[13px] font-semibold">
            Документы{docs.data ? ` (${items.length})` : ""}
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
          {docs.data && items.length === 0 && (
            <p className="text-[13px] text-[var(--muted-foreground)]">
              У кандидата нет документов.
            </p>
          )}
          {items.length > 0 && (
            <ul className="flex flex-col gap-2">
              {items.map((doc) => (
                <li
                  key={doc.id}
                  className="overflow-hidden rounded-[8px] border border-[var(--border)]"
                >
                  <button
                    type="button"
                    aria-label={`${doc.title}, версия ${doc.currentVersion}`}
                    onClick={() =>
                      void navigate({
                        to: "/review/$documentId",
                        params: { documentId: doc.id },
                        search: { version: doc.currentVersion },
                      })
                    }
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--muted)]/40"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[13px] font-semibold">
                        {doc.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">
                        Версия {doc.currentVersion}
                      </span>
                    </span>
                    <StatusBadge status={doc.status} document />
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
        </div>
      </div>
    </dialog>
  );
}
