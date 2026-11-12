import { DocumentReviewDialog } from "../components/DocumentReviewDialog";
import { useCandidateDocumentSync } from "../lib/use-candidate-document-sync";
import { CandidateAvatar } from "../components/CandidateAvatar";
import { CandidatePhotoUploadDialog } from "../components/CandidatePhotoUploadDialog";
import { canUploadCandidatePhoto } from "../lib/review-groups";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useGetCandidateDetails,
  getGetCandidateDetailsQueryKey,
  useGetMe,
  getGetCandidateWorkspaceQueryKey,
  useGetCandidateWorkspace,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { Badge, Button, EmptyState, StatusBadge } from "@edo/ui";
import {
  ArrowLeft,
  Briefcase,
  Building2,
  Calendar,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Upload,
  User,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { CandidateManagement } from "../components/CandidateManagement";
import { CandidateStageAccordion } from "../components/CandidateStageAccordion";
import { hasAccessRule } from "../lib/audit-types";
import { CandidateChat } from "../components/CandidateChat";
import { LkLink } from "../components/LkLink";
import { assembleCandidateStages } from "../lib/candidate-stages";
import {
  formatBirthDateRu,
  formatCandidateObject,
  parseReviewSearchParams,
} from "../lib/review-groups";
import { parseVersionParam } from "../lib/audit-types";

function getStatusDotClass(status?: string | null): string {
  if (!status) return "bg-[var(--muted-foreground)]";
  const s = status.toLowerCase();
  if (/принят|оформлен|approved|signed|done|success/i.test(s)) {
    return "bg-[var(--success)]";
  }
  if (/заезд|arrival|проверк|approval|review|warning|мо|уц|сб/i.test(s)) {
    return "bg-[var(--warning)]";
  }
  if (/отказ|failed|danger|expired|отклон/i.test(s)) {
    return "bg-[var(--danger)]";
  }
  if (/подбор|recruiting|potential|in_progress|направлен/i.test(s)) {
    return "bg-[var(--info)]";
  }
  return "bg-[var(--primary)]";
}

function getCandidateInitials(name?: string | null): string {
  if (!name) return "К";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return (parts[0]?.[0] || "К").toUpperCase();
}


export function CandidateWorkspacePage() {
  const me = useGetMe();
  const { candidateId } = useParams({ strict: false }) as {
    candidateId: string;
  };
  if (!hasAccessRule(me.data, 20002) && !hasAccessRule(me.data, 20009))
    return (
      <div className="p-4">
        <EmptyState
          title={me.isLoading ? "Загрузка прав…" : "Нет доступа"}
          description="Карточка кандидата доступна сотрудникам направления Россия."
        />
      </div>
    );
  return <CandidateWorkspace key={candidateId} />;
}

function CandidateWorkspace() {
  const me = useGetMe();
  const { candidateId } = useParams({ strict: false }) as {
    candidateId: string;
  };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const stage = /^(none|[1-9]\d{0,14})$/.test(String(search.stage ?? ""))
    ? String(search.stage)
    : undefined;
  const details = useCandidateDocumentSync(candidateId);
  const stageParams = stage ? { stage } : undefined;
  const stageDetails = useGetCandidateDetails(candidateId, stageParams, {
    query: {
      enabled: !!stage,
      queryKey: getGetCandidateDetailsQueryKey(candidateId, stageParams),
    },
  });
  const workspace = useGetCandidateWorkspace(candidateId, {
    query: {
      enabled: false,
      queryKey: getGetCandidateWorkspaceQueryKey(candidateId),
    },
  });
  const [collapsed, setCollapsed] = useState(false);
  const [isPhotoUploadOpen, setIsPhotoUploadOpen] = useState(false);
  const candidatesPanel = useRef<HTMLElement>(null);
  const documentsPanel = useRef<HTMLElement>(null);
  const [mobilePanel, setMobilePanel] = useState<
    "candidates" | "documents" | null
  >(() =>
    search.section === "profile" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 1023px)").matches
      ? "candidates"
      : null,
  );
  useEffect(() => {
    if (!mobilePanel) return;
    const panel =
      mobilePanel === "candidates"
        ? candidatesPanel.current
        : documentsPanel.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary",
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    controls()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobilePanel(null);
      }
      if (event.key === "Tab") {
        const elements = controls(),
          first = elements[0],
          last = elements.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !panel?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !panel?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [mobilePanel]);
  const profile = details.data?.candidate;
  const candidateStatus =
    typeof (profile as { status?: unknown })?.status === "string"
      ? ((profile as { status?: string }).status as string)
      : (profile as { status?: { name?: string | null } })?.status?.name ||
        profile?.statusName ||
        workspace.data?.status?.name;
  const candidateName =
    workspace.data?.fullName || profile?.fullName || "Кандидат";
  const documentId =
    typeof search.document === "string" && search.document.length <= 64
      ? search.document
      : undefined;
  const version = parseVersionParam(search.version);
  const previousDocumentId = typeof search.previousDocument === "string" ? search.previousDocument : undefined;
  const uploading = search.uploadDocument === true;

  const queueSearch = { ...parseReviewSearchParams(search, "ALL") };
  delete queueSearch.candidate;
  const openDocument = (
    docOrId: CandidateDocumentSummaryDto | string,
    selectedVersion?: number,
  ) => {
    const docId = typeof docOrId === "string" ? docOrId : docOrId.id;
    const ver =
      typeof docOrId === "string"
        ? selectedVersion
        : (selectedVersion ?? docOrId.currentVersion);
    setMobilePanel(null);
    void navigate({
      to: "/review/candidates/$candidateId",
      params: { candidateId },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        document: docId,
        version: ver,
        previousDocument: undefined,
        uploadDocument: undefined,
      }),
    });
  };

  const stages = useMemo(() => {
    const effectiveData =
      (stage ? stageDetails.data : details.data) ?? details.data;
    return assembleCandidateStages(effectiveData, { stage });
  }, [details.data, stageDetails.data, stage]);

  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({});

  const isStageOpen = (stgNumber: number | null, index: number) => {
    const key = stgNumber === null ? "none" : String(stgNumber);
    if (key in expandedStages) {
      return expandedStages[key];
    }
    if (stage !== undefined && stage !== "") {
      if (stage === "none") return stgNumber === null;
      return String(stgNumber) === stage;
    }
    // Default: expand Stage 1 (or the first stage if none is 1)
    if (stgNumber === 1) return true;
    const hasStageOne = stages.some((s) => s.stage === 1);
    if (!hasStageOne && index === 0) return true;
    return false;
  };

  const toggleStage = (stgNumber: number | null, _index: number) => {
    const key = stgNumber === null ? "none" : String(stgNumber);
    const currentlyActive = stage === key;
    const willOpen = !currentlyActive;
    setExpandedStages((prev) => ({ ...prev, [key]: willOpen }));
    void navigate({
      to: "/review/candidates/$candidateId",
      params: { candidateId },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        stage: willOpen ? key : undefined,
        document: undefined,
        version: undefined,
      }),
    });
  };

  const totalDocCount = useMemo(() => {
    if (stages.length > 0) {
      return stages.reduce(
        (sum, s) =>
          sum +
          new Set([
            ...s.required.documents.map((doc) => doc.documentTypeCode ?? doc.id),
            ...s.additional.documents.map((doc) => doc.documentTypeCode ?? doc.id),
            ...s.previousDocuments.map((doc) => doc.documentTypeCode),
          ]).size,
        0,
      );
    }
    return details.data?.documents?.length ?? 0;
  }, [stages, details.data?.documents]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 sm:p-4">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <Link
            to="/review"
            search={queueSearch}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <ArrowLeft size={14} />
            <span>Очередь проверки</span>
          </Link>
          <span className="select-none text-[var(--border)]" aria-hidden="true">
            /
          </span>
          <span className="truncate text-[13px] font-medium text-[var(--foreground)]">
            {workspace.data?.fullName || profile?.fullName || "Кандидат"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/candidates"
            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 text-[13px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
          >
            <Users size={14} className="text-[var(--muted-foreground)]" />
            <span>Каталог кандидатов</span>
          </Link>
          <Button
            size="sm"
            variant="outline"
            className="lg:hidden"
            onClick={() => setMobilePanel("candidates")}
          >
            <PanelLeftOpen size={15} />
            Данные кандидата
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="lg:hidden"
            onClick={() => setMobilePanel("documents")}
          >
            <FileText size={15} />
            Документы{details.data && !details.synchronizing ? ` (${totalDocCount})` : ""}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        {mobilePanel && (
          <button
            type="button"
            aria-label="Закрыть панель"
            className="fixed inset-0 z-30 bg-black/30 lg:hidden"
            onClick={() => setMobilePanel(null)}
          />
        )}
        <aside
          ref={candidatesPanel}
          role={mobilePanel === "candidates" ? "dialog" : undefined}
          aria-modal={mobilePanel === "candidates" ? true : undefined}
          aria-label="Данные и оформление кандидата"
          className={`${mobilePanel === "candidates" ? "fixed inset-y-0 left-0 z-40 flex w-[min(92vw,400px)] shadow-xl" : collapsed ? "hidden w-12 lg:flex" : "hidden w-80 xl:w-96 lg:flex"} shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]`}
        >
          <div
            className={`flex shrink-0 items-center ${
              collapsed && !mobilePanel
                ? "justify-center p-2"
                : "justify-between p-3"
            } border-b border-[var(--border)]`}
          >
            {(!collapsed || mobilePanel) && (
              <h2 className="text-sm font-semibold">Данные и оформление</h2>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="hidden h-7 px-1 lg:inline-flex"
              aria-label={
                collapsed
                  ? "Развернуть данные кандидата"
                  : "Свернуть данные кандидата"
              }
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? (
                <PanelLeftOpen size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              aria-label="Закрыть данные кандидата"
              onClick={() => setMobilePanel(null)}
            >
              <X size={18} />
            </Button>
          </div>
          {collapsed && !mobilePanel && (
            <div
              className="flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-between py-3 select-none transition-colors hover:bg-[var(--muted)]/40"
              onClick={() => setCollapsed(false)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setCollapsed(false);
                }
              }}
              aria-label="Развернуть данные кандидата"
              title="Нажмите, чтобы развернуть данные кандидата"
            >
              <div className="flex flex-col items-center pt-1">
                {candidateStatus ? (
                  <span
                    className="relative flex h-2.5 w-2.5"
                    title={`Статус: ${candidateStatus}`}
                  >
                    <span
                      className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${getStatusDotClass(
                        candidateStatus,
                      )}`}
                    />
                    <span
                      className={`relative inline-flex h-2.5 w-2.5 rounded-full ${getStatusDotClass(
                        candidateStatus,
                      )}`}
                    />
                  </span>
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--muted-foreground)]" />
                )}
              </div>

              <div className="my-auto flex flex-1 items-center justify-center py-2">
                <span
                  className="max-h-[280px] truncate text-xs font-semibold tracking-wide text-[var(--muted-foreground)] [writing-mode:vertical-rl] rotate-180"
                  title={candidateName}
                >
                  {candidateName}
                </span>
              </div>

              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[11px] font-bold text-[var(--primary)]"
                title={candidateName}
              >
                {getCandidateInitials(candidateName)}
              </div>
            </div>
          )}
          {(!collapsed || mobilePanel === "candidates") && (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <CandidateManagement
                candidateId={candidateId}
                compact
                fallbackProfile={profile}
              />
            </div>
          )}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <header className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
            {details.isLoading ? (
              <p role="status">Загрузка кандидата…</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <CandidateAvatar
                    candidateId={candidateId}
                    fullName={
                      workspace.data?.fullName ||
                      profile?.fullName ||
                      "Кандидат"
                    }
                    photoPath={profile?.photoPath}
                    size="md"
                    editable={canUploadCandidatePhoto(
                      me.data?.permissions,
                      profile,
                    )}
                    onUploadClick={() => setIsPhotoUploadOpen(true)}
                    allowEnlarge
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="min-w-0 break-words text-lg font-bold text-[var(--foreground)]">
                      {workspace.data?.fullName ||
                        profile?.fullName ||
                        "Кандидат"}
                    </h1>
                    {candidateStatus && <StatusBadge status={candidateStatus} />}
                    {profile?.citizenship && (
                      <Badge>{profile.citizenship.toUpperCase()}</Badge>
                    )}
                    {profile?.isReemployment && (
                      <Badge tone="warning">Повторный найм</Badge>
                    )}
                  </div>
                </div>
                {profile && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted-foreground)]">
                    {(() => {
                      const birthDate =
                        profile.birthDate &&
                        formatBirthDateRu(profile.birthDate) !== "—"
                          ? formatBirthDateRu(profile.birthDate)
                          : null;
                      const position = profile.positionName?.trim() || null;
                      const objectText =
                        profile.projectName || profile.projectCode
                          ? formatCandidateObject(
                              profile.projectName,
                              profile.projectCode,
                            ).replace(/^Объект:\s*/, "")
                          : null;
                      const manager = profile.managerName?.trim() ? (
                        <span>
                          Менеджер:{" "}
                          {profile.managerCode1c ? (
                            <LkLink code1c={profile.managerCode1c}>
                              {profile.managerName}
                            </LkLink>
                          ) : (
                            profile.managerName
                          )}
                        </span>
                      ) : null;
                      const mentor = profile.mentorName?.trim() ? (
                        <span>Наставник: {profile.mentorName}</span>
                      ) : null;

                      const items = [
                        birthDate ? (
                          <span
                            key="birthDate"
                            className="inline-flex items-center gap-1.5"
                          >
                            <Calendar
                              size={13}
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                            <span>{birthDate}</span>
                          </span>
                        ) : null,
                        position ? (
                          <span
                            key="position"
                            className="inline-flex items-center gap-1.5"
                          >
                            <Briefcase
                              size={13}
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                            <span>{position}</span>
                          </span>
                        ) : null,
                        objectText ? (
                          <span
                            key="object"
                            className="inline-flex items-center gap-1.5"
                          >
                            <Building2
                              size={13}
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                            <span>{objectText}</span>
                          </span>
                        ) : null,
                        manager ? (
                          <span
                            key="manager"
                            className="inline-flex items-center gap-1.5"
                          >
                            <User
                              size={13}
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                            {manager}
                          </span>
                        ) : null,
                        mentor ? (
                          <span
                            key="mentor"
                            className="inline-flex items-center gap-1.5"
                          >
                            <UserCheck
                              size={13}
                              className="shrink-0 text-[var(--muted-foreground)]"
                            />
                            {mentor}
                          </span>
                        ) : null,
                      ].filter(Boolean);

                      return items.map((item, index) => (
                        <Fragment key={index}>
                          {index > 0 && (
                            <span
                              className="select-none text-[var(--border)]"
                              aria-hidden="true"
                            >
                              ·
                            </span>
                          )}
                          {item}
                        </Fragment>
                      ));
                    })()}
                  </div>
                )}
              </>
            )}
          </header>
          {details.isError ? (
            <div role="alert" className="p-4 text-sm">
              Кандидат не найден или недоступен.{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void details.refetch()}
              >
                Повторить
              </Button>
            </div>
          ) : (
            details.data && (
              <>
                {/* Keep the chat mounted while checking documents: connection, scroll
              position and an unsent draft survive switching the center view. */}
                <div className="min-h-0 flex-1">
                  <CandidateChat key={candidateId} candidateId={candidateId} />
                </div>

              </>
            )
          )}
        </div>
        <aside
          ref={documentsPanel}
          role={mobilePanel === "documents" ? "dialog" : undefined}
          aria-modal={mobilePanel === "documents" ? true : undefined}
          aria-label="Документы кандидата"
          className={`${mobilePanel === "documents" ? "fixed inset-y-0 right-0 z-40 flex w-[min(92vw,400px)] shadow-xl" : "hidden w-80 xl:w-96 lg:flex"} shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <FileText size={15} className="text-[var(--muted-foreground)]" aria-hidden="true" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Документы
              </h2>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                onClick={() =>
                  void navigate({
                    to: "/review/candidates/$candidateId",
                    params: { candidateId },
                    search: (prev: Record<string, unknown>) => ({
                      ...prev,
                      document: undefined,
                      previousDocument: undefined,
                      version: undefined,
                      uploadDocument: true,
                    }),
                  })
                }
                title="Загрузить документ от лица сотрудника"
              >
                <Upload size={13} className="mr-1" aria-hidden="true" />
                Загрузить
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 lg:hidden"
                aria-label="Закрыть список документов"
                onClick={() => setMobilePanel(null)}
              >
                <X size={16} />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2.5">
            {stage &&
              stageDetails.isFetching &&
              !stageDetails.data?.stageDocuments && (
                <p
                  role="status"
                  className="p-2 text-sm text-[var(--muted-foreground)]"
                >
                  Загрузка документов этапа…
                </p>
              )}
            {details.synchronizing && (
              <p
                role="status"
                className="p-2 text-sm text-[var(--muted-foreground)]"
              >
                {details.data?.enrichment?.status === "RETRY"
                  ? "Не удалось синхронизировать документы. Повторим автоматически."
                  : "Синхронизация профиля и документов…"}
                {details.syncError && (
                  <Button size="sm" variant="outline" onClick={details.requestSync}>Повторить синхронизацию</Button>
                )}
              </p>
            )}
            {details.isError && (
              <div
                role="alert"
                className="p-2 text-sm text-[var(--primary)]"
              >
                Не удалось загрузить документы.
              </div>
            )}
            {details.data && !details.synchronizing && stages.length > 0 && (
              <div className="space-y-3">
                {stages.map((stg, index) => (
                  <CandidateStageAccordion
                    key={`stage-${stg.stage ?? "none"}-${index}`}
                    progress={profile?.stageProgress?.find((item) => item.stage === stg.stage)}
                    stage={stg.stage}
                    title={stg.title}
                    required={stg.required}
                    additional={stg.additional}
                    previousDocuments={stg.previousDocuments}
                    reviewGroup={profile?.reviewGroup}
                    candidateId={candidateId}
                    isOpen={isStageOpen(stg.stage, index)}
                    onToggle={() => toggleStage(stg.stage, index)}
                    onOpenPrevious={(id) => void navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: (prev: Record<string, unknown>) => ({ ...prev, document: undefined, version: undefined, previousDocument: id }) })}
                    onReviewDocument={openDocument}
                  />
                ))}
              </div>
            )}
            {details.data && !details.synchronizing && stages.length === 0 && (
              <p className="p-2 text-xs text-[var(--muted-foreground)]">
                Документы отсутствуют.
              </p>
            )}
          </div>
        </aside>
      </div>
      {(documentId || previousDocumentId || uploading) && (
        <DocumentReviewDialog candidateId={candidateId} documentId={documentId}
          previousDocumentId={previousDocumentId} version={version} uploading={uploading}
          onClose={() => void navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: (prev: Record<string, unknown>) => { const next = { ...prev }; for (const key of ["document", "version", "previousDocument", "uploadDocument"]) delete next[key]; return next; } })}
          chooseVersion={(selected) => void navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: (prev: Record<string, unknown>) => ({ ...prev, version: selected }) })}
          onUploaded={async (id, number) => { await details.refetch(); await navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: (prev: Record<string, unknown>) => ({ ...prev, document: id, version: number, previousDocument: undefined, uploadDocument: undefined }) }); }}
        />
      )}
      <CandidatePhotoUploadDialog
        candidateId={candidateId}
        fullName={workspace.data?.fullName || profile?.fullName}
        isOpen={isPhotoUploadOpen}
        onClose={() => setIsPhotoUploadOpen(false)}
        onSuccess={() => {
          void details.refetch();
          void workspace.refetch();
        }}
      />
    </div>
  );
}
