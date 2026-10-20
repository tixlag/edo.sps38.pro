import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useGetCandidateDetails,
  useGetDocumentInfo,
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
  useListCommunicationCandidates,
  type CandidateDocumentSummaryDto,
} from "@edo/api-client";
import { Badge, Button, EmptyState, StatusBadge } from "@edo/ui";
import {
  ArrowLeft,
  FileText,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Users,
  X,
} from "lucide-react";
import { CandidateChat } from "../components/CandidateChat";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import { LkLink } from "../components/LkLink";
import {
  candidateInitials,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
  parseReviewSearchParams,
} from "../lib/review-groups";
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
  const version = useGetDocumentVersion(documentId, number, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, number),
      enabled: correctOwner && !!number,
    },
  });
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
  const { candidateId } = useParams({ strict: false }) as {
    candidateId: string;
  };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const details = useGetCandidateDetails(candidateId);
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 1279px)").matches,
  );
  const candidatesPanel = useRef<HTMLElement>(null);
  const documentsPanel = useRef<HTMLElement>(null);
  const [mobilePanel, setMobilePanel] = useState<
    "candidates" | "documents" | null
  >(null);
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
  const [query, setQuery] = useState(""),
    [debouncedQuery, setDebouncedQuery] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [previousCursors, setPreviousCursors] = useState<
    (string | undefined)[]
  >([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCursor(undefined);
      setPreviousCursors([]);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const candidates = useListCommunicationCandidates({
    q: debouncedQuery || undefined,
    limit: 50,
    cursor,
  });
  const profile = details.data?.candidate;
  const documentId =
    typeof search.document === "string" && search.document.length <= 64
      ? search.document
      : undefined;
  const version = parseVersionParam(search.version);
  const queueSearch = { ...parseReviewSearchParams(search) };
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
  const documents = [...(details.data?.documents ?? [])].sort((a, b) =>
    a.title.localeCompare(b.title, "ru"),
  );
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
        <Button
          size="sm"
          variant="outline"
          className="lg:hidden"
          onClick={() => setMobilePanel("candidates")}
        >
          <Users size={15} />
          Кандидаты
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
          aria-label="Кандидаты"
          className={`${mobilePanel === "candidates" ? "fixed inset-y-0 left-0 z-40 flex w-[min(88vw,320px)] shadow-xl" : collapsed ? "hidden w-12 lg:flex" : "hidden w-60 xl:w-64 lg:flex"} shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]`}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] p-3">
            {(!collapsed || mobilePanel) && (
              <h2 className="text-sm font-semibold">Кандидаты</h2>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="hidden h-7 px-1 lg:inline-flex"
              aria-label={
                collapsed
                  ? "Развернуть список кандидатов"
                  : "Свернуть список кандидатов"
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
              aria-label="Закрыть список кандидатов"
              onClick={() => setMobilePanel(null)}
            >
              <X size={18} />
            </Button>
          </div>
          {(!collapsed || mobilePanel === "candidates") && (
            <>
              <label className="relative m-3 block">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-2 top-2.5 text-[var(--muted-foreground)]"
                />
                <span className="sr-only">Поиск кандидата по ФИО</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Поиск по ФИО"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-2 pl-7 pr-2 text-[13px]"
                />
              </label>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {candidates.isLoading && (
                  <p role="status" className="px-3 text-sm">
                    Загрузка кандидатов…
                  </p>
                )}
                {candidates.isError && (
                  <div role="alert" className="p-3 text-xs">
                    Не удалось загрузить список.{" "}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void candidates.refetch()}
                    >
                      Повторить
                    </Button>
                  </div>
                )}
                {candidates.data?.items.length === 0 && (
                  <p className="px-3 text-xs text-[var(--muted-foreground)]">
                    Кандидаты не найдены.
                  </p>
                )}
                <ul>
                  {candidates.data?.items.map((candidate) => (
                    <li key={candidate.id}>
                      <Link
                        to="/review/candidates/$candidateId"
                        params={{ candidateId: candidate.id }}
                        search={queueSearch}
                        onClick={() => setMobilePanel(null)}
                        aria-current={
                          candidate.id === candidateId ? "page" : undefined
                        }
                        className={`flex gap-2 border-b border-[var(--border)] px-3 py-3 text-left hover:bg-[var(--muted)] ${candidate.id === candidateId ? "bg-[var(--primary-soft)]" : ""}`}
                      >
                        <span
                          aria-hidden
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] text-xs font-semibold"
                        >
                          {candidateInitials(candidate.fullName)}
                        </span>
                        <span className="min-w-0">
                          <span className="block break-words text-[13px] font-medium">
                            {candidate.fullName || "Без имени в профиле"}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--muted-foreground)]">
                            {candidate.positionName ||
                              formatCandidateObject(
                                candidate.projectName,
                                candidate.projectCode,
                              )}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex shrink-0 items-center justify-between gap-1 border-t border-[var(--border)] p-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!previousCursors.length}
                  onClick={() => {
                    setCursor(previousCursors.at(-1));
                    setPreviousCursors((previous) => previous.slice(0, -1));
                  }}
                >
                  Назад
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!candidates.data?.nextCursor}
                  onClick={() => {
                    setPreviousCursors((previous) => [...previous, cursor]);
                    setCursor(candidates.data?.nextCursor ?? undefined);
                  }}
                >
                  Далее
                </Button>
              </div>
              {candidates.data && !candidates.data.syncedAt && (
                <p
                  role="status"
                  className="p-2 pt-0 text-xs text-[var(--muted-foreground)]"
                >
                  Каталог 1С ещё не синхронизирован.
                </p>
              )}
            </>
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
                    {profile?.fullName || "Кандидат"}
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
            {details.isLoading && (
              <p role="status" className="p-2 text-sm">
                Загрузка документов…
              </p>
            )}
            {details.data && !documents.length && (
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
