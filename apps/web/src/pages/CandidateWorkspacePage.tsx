import { useEffect, useRef, useState } from "react";
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
  useGetDocumentInfo,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { Badge, Button, EmptyState, StatusBadge } from "@edo/ui";
import {
  ArrowLeft,
  FileText,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { CandidateManagement } from "../components/CandidateManagement";
import { StageRing } from "./ReviewPage";
import { CandidateRequirements } from "../components/CandidateRequirements";
import { hasAccessRule } from "../lib/audit-types";
import { CandidateChat } from "../components/CandidateChat";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import { LkLink } from "../components/LkLink";
import {
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
  parseReviewSearchParams,
} from "../lib/review-groups";
import { useLiveDocumentVersion } from "../lib/use-live-document-version";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";

function CandidateDocumentReview({
  candidateId,
  documentId,
  version: requestedVersion,
  chooseVersion,
}: {
  candidateId: string;
  documentId: string;
  version?: number;
  chooseVersion: (version: number) => void;
}) {
  const info = useGetDocumentInfo(documentId);
  const number = requestedVersion ?? info.data?.currentVersion ?? 0;
  const correctOwner = info.data?.candidateId === candidateId;
  const version = useLiveDocumentVersion(documentId, correctOwner ? number : 0);
  const historic = isHistoricVersion(number, info.data?.currentVersion);
  if (info.isLoading || (correctOwner && version.isLoading))
    return (
      <p role="status" className="p-4">
        Загрузка документа…
      </p>
    );
  if (info.isError || !correctOwner || version.isError)
    return (
      <div role="alert" className="p-4 text-sm">
        Документ недоступен или не принадлежит этому кандидату.{" "}
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void info.refetch();
            void version.refetch();
          }}
        >
          Повторить
        </Button>
      </div>
    );
  if (!version.data) return null;
  const numbers = [
    ...new Set([
      info.data!.currentVersion,
      ...info.data!.pendingDeliveryVersions,
      ...(info.data!.returnedVersions?.map((v) => v.version) ?? []),
      number,
    ]),
  ].sort((a, b) => b - a);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto lg:overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm">
        <h2 className="mr-auto font-semibold">{info.data?.title}</h2>
        <StatusBadge status={version.data.status} document />
        <label className="text-xs">
          Версия{" "}
          <select
            aria-label="Версия документа"
            value={number}
            onChange={(event) => chooseVersion(Number(event.target.value))}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1"
          >
            {numbers.map((v) => (
              <option key={v} value={v}>
                {v}
                {v === info.data?.currentVersion ? " — текущая" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {historic && (
        <p role="status" className="rounded-md bg-[var(--muted)] p-2 text-xs">
          Историческая версия {number}. Изменение запрещено.{" "}
          <button
            onClick={() => chooseVersion(info.data!.currentVersion)}
            className="underline"
          >
            Открыть актуальную версию
          </button>
        </p>
      )}
      <div className="min-h-0 flex-1">
        <DocumentReviewWorkspace
          key={`${documentId}:${number}`}
          candidateId={candidateId}
          data={version.data}
          readOnly={historic}
          fitContainer
        />
      </div>
    </div>
  );
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
  const { candidateId } = useParams({ strict: false }) as {
    candidateId: string;
  };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const stage = /^(none|[1-9]\d{0,14})$/.test(String(search.stage ?? ""))
    ? String(search.stage)
    : undefined;
  const details = useGetCandidateDetails(candidateId);
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
  const documentId =
    typeof search.document === "string" && search.document.length <= 64
      ? search.document
      : undefined;
  const version = parseVersionParam(search.version);
  const queueSearch = { ...parseReviewSearchParams(search, "ALL") };
  delete queueSearch.candidate;
  const openDocument = (
    document: CandidateDocumentSummaryDto,
    selectedVersion = document.currentVersion,
  ) => {
    setMobilePanel(null);
    void navigate({
      to: "/review/candidates/$candidateId",
      params: { candidateId },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        document: document.id,
        version: selectedVersion,
      }),
    });
  };
  const stageData = stage ? stageDetails.data?.stageDocuments : undefined;
  const missing = stageData
    ? [
        ...stageData.required.missingDocuments,
        ...stageData.additional.missingDocuments,
      ]
    : [];
  const documents = [
    ...(stage
      ? [
          ...(stageData?.required.documents ?? []),
          ...(stageData?.additional.documents ?? []),
        ]
      : (details.data?.documents ?? [])),
  ].sort((a, b) => a.title.localeCompare(b.title, "ru"));
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 sm:p-4">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link
          to="/review"
          search={queueSearch}
          className="mr-auto inline-flex items-center gap-1 text-[13px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={15} />
          Очередь проверки
        </Link>
        <Link
          to="/candidates"
          className="text-sm text-[var(--primary)] underline underline-offset-4"
        >
          Каталог кандидатов
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
          Документы{details.data ? ` (${documents.length})` : ""}
        </Button>
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
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] p-3">
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
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="min-w-0 break-words text-base font-semibold">
                    {workspace.data?.fullName ||
                      profile?.fullName ||
                      "Кандидат"}
                  </h1>
                  {profile?.citizenship && (
                    <Badge>{profile.citizenship.toUpperCase()}</Badge>
                  )}
                  {profile?.isReemployment && (
                    <Badge tone="warning">Повторный найм</Badge>
                  )}
                </div>
                {profile && (
                  <div className="mt-1 hidden flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted-foreground)] sm:flex">
                    <span>{formatBirthDateRu(profile.birthDate)}</span>
                    <span>{profile.positionName}</span>
                    <span>
                      {formatCandidateObject(
                        profile.projectName,
                        profile.projectCode,
                      )}
                    </span>
                    {profile.managerName && (
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
                    )}
                    {profile.mentorName && (
                      <span>Наставник: {profile.mentorName}</span>
                    )}
                  </div>
                )}
                {profile && (
                  <details className="mt-1 text-xs text-[var(--muted-foreground)] sm:hidden">
                    <summary className="cursor-pointer">
                      Данные кандидата
                    </summary>
                    <p className="mt-1">
                      {formatBirthDateRu(profile.birthDate)} ·{" "}
                      {profile.positionName}
                    </p>
                    <p className="mt-1">
                      {formatCandidateObject(
                        profile.projectName,
                        profile.projectCode,
                      )}
                    </p>
                    {profile.managerName && (
                      <p className="mt-1">Менеджер: {profile.managerName}</p>
                    )}
                    {profile.mentorName && (
                      <p className="mt-1">Наставник: {profile.mentorName}</p>
                    )}
                  </details>
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
                <nav
                  aria-label="Этапы документов"
                  className="flex shrink-0 items-start gap-2 overflow-x-auto"
                >
                  <Button
                    size="sm"
                    variant={!stage ? "default" : "outline"}
                    onClick={() =>
                      void navigate({
                        to: "/review/candidates/$candidateId",
                        params: { candidateId },
                        search: (previous: Record<string, unknown>) => ({
                          ...previous,
                          stage: undefined,
                          document: undefined,
                          version: undefined,
                        }),
                      })
                    }
                  >
                    Все документы
                  </Button>
                  {profile?.stageProgress?.map((progress) => (
                    <StageRing
                      key={progress.stage ?? "none"}
                      progress={progress}
                      selected={
                        stage ===
                        (progress.stage === null
                          ? "none"
                          : String(progress.stage))
                      }
                      onOpen={() => {
                        void navigate({
                          to: "/review/candidates/$candidateId",
                          params: { candidateId },
                          search: (previous: Record<string, unknown>) => ({
                            ...previous,
                            document: undefined,
                            version: undefined,
                            stage:
                              progress.stage === null
                                ? "none"
                                : String(progress.stage),
                          }),
                        });
                        if (
                          typeof window.matchMedia === "function" &&
                          window.matchMedia("(max-width: 1023px)").matches
                        )
                          setMobilePanel("documents");
                      }}
                    />
                  ))}
                  {profile?.stageProgress === null && (
                    <span className="text-xs text-[var(--muted-foreground)]">
                      Этапы неизвестны
                    </span>
                  )}
                </nav>
                {documentId && (
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void navigate({
                          to: "/review/candidates/$candidateId",
                          params: { candidateId },
                          search: (prev: Record<string, unknown>) => {
                            const next = { ...prev };
                            delete next.document;
                            delete next.version;
                            return next;
                          },
                        })
                      }
                    >
                      <MessageSquare size={15} />
                      Чат кандидата
                    </Button>
                  </div>
                )}
                {/* Keep the chat mounted while checking documents: connection, scroll
              position and an unsent draft survive switching the center view. */}
                <div className={`min-h-0 flex-1 ${documentId ? "hidden" : ""}`}>
                  <CandidateChat key={candidateId} candidateId={candidateId} />
                </div>
                {documentId && (
                  <div className="min-h-0 flex-1">
                    <CandidateDocumentReview
                      key={`${candidateId}:${documentId}`}
                      candidateId={candidateId}
                      documentId={documentId}
                      version={version}
                      chooseVersion={(selected) =>
                        void navigate({
                          to: "/review/candidates/$candidateId",
                          params: { candidateId },
                          search: (prev: Record<string, unknown>) => ({
                            ...prev,
                            version: selected,
                          }),
                        })
                      }
                    />
                  </div>
                )}
              </>
            )
          )}
        </div>
        <aside
          ref={documentsPanel}
          role={mobilePanel === "documents" ? "dialog" : undefined}
          aria-modal={mobilePanel === "documents" ? true : undefined}
          aria-label="Документы кандидата"
          className={`${mobilePanel === "documents" ? "fixed inset-y-0 right-0 z-40 flex w-[min(88vw,320px)] shadow-xl" : "hidden w-60 xl:w-64 lg:flex"} shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] p-3">
            <h2 className="text-sm font-semibold">
              Документы{details.data ? ` (${documents.length})` : ""}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              className="lg:hidden"
              aria-label="Закрыть список документов"
              onClick={() => setMobilePanel(null)}
            >
              <X size={18} />
            </Button>
          </div>
          {profile && (
            <p className="shrink-0 border-b border-[var(--border)] p-3 text-xs text-[var(--muted-foreground)]">
              {formatDocumentProgress(
                profile.approvedDocuments,
                profile.requiredDocuments,
              )}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!stage && (
              <CandidateRequirements
                candidateId={candidateId}
                documents={documents}
              />
            )}
            {stage && stageDetails.isFetching && (
              <p role="status" className="p-2 text-xs">
                Загрузка документов этапа…
              </p>
            )}
            {stage && !stageDetails.isFetching && !stageData && (
              <p role="status" className="p-2 text-xs">
                Не удалось определить документы выбранного этапа.
              </p>
            )}
            {stage && missing.length > 0 && (
              <section className="mb-3 border-b border-[var(--border)] p-2">
                <h3 className="mb-2 text-xs font-semibold">Не загружены</h3>
                <ul className="space-y-1">
                  {missing.map((item) => (
                    <li key={item.code} className="text-xs">
                      {item.title}{" "}
                      <span className="text-[var(--muted-foreground)]">
                        ·{" "}
                        {stageData?.required.missingDocuments.some(
                          (entry) => entry.code === item.code,
                        )
                          ? "обязательный"
                          : "дополнительный"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {details.isLoading && (
              <p role="status" className="p-2 text-sm">
                Загрузка документов…
              </p>
            )}
            {details.data &&
              (!stage || stageData) &&
              !documents.length &&
              !missing.length && (
                <EmptyState
                  title="Документов пока нет"
                  description="Кандидат ещё не загрузил документы в EDO."
                />
              )}
            <ul className="flex flex-col gap-2">
              {documents.map((document) => (
                <li
                  key={document.id}
                  className={`overflow-hidden rounded-lg border border-[var(--border)] ${documentId === document.id ? "bg-[var(--primary-soft)]" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => openDocument(document)}
                    className="block w-full p-3 text-left hover:bg-[var(--muted)]"
                    aria-current={
                      documentId === document.id ? "true" : undefined
                    }
                  >
                    <span className="mb-1 block break-words text-[13px] font-medium">
                      {document.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={document.status} document />
                      {stageData && (
                        <span className="text-xs text-[var(--muted-foreground)]">
                          {stageData.required.documents.some(
                            (item) => item.id === document.id,
                          )
                            ? "Обязательный"
                            : "Дополнительный"}
                        </span>
                      )}
                      <span className="text-xs text-[var(--muted-foreground)]">
                        Версия {document.currentVersion}
                      </span>
                    </span>
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
                          className="mt-2 block text-left underline"
                          onClick={() =>
                            openDocument(document, returned.version)
                          }
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
                    <p className="px-3 pb-2 text-xs text-[var(--muted-foreground)]">
                      Требует отправки в ERP:{" "}
                      {document.pendingDeliveryVersions.map((pending) => (
                        <button
                          key={pending}
                          type="button"
                          className="mr-1 underline"
                          onClick={() => openDocument(document, pending)}
                        >
                          {pending}
                        </button>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
