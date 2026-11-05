import { useMemo, useState } from "react";
import {
  useGetMe,
  useListIgArrivalGroups,
  useListIgArrivalPeople,
  getListIgArrivalGroupsQueryKey,
  getListIgArrivalPeopleQueryKey,
  type IgArrivalGroupDto,
  type IgArrivalPersonDtoPrimaryStatus,
} from "@edo/api-client";
import { Badge, Button, Card, CardContent, EmptyState } from "@edo/ui";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { formatDateRu } from "../lib/date-format";
import { candidateInitials } from "../lib/review-groups";

export interface IgArrivalReviewQueueProps {
  onSelectCandidate: (candidateId: string) => void;
  className?: string;
}

const PRIMARY_STATUS_CONFIG: Record<
  IgArrivalPersonDtoPrimaryStatus,
  {
    label: string;
    tone: "default" | "purple" | "warning" | "danger" | "info" | "success";
  }
> = {
  waitingDocuments: { label: "Ожидание документов", tone: "default" },
  inReview: { label: "На проверке", tone: "purple" },
  returned: { label: "Возвращён", tone: "danger" },
  sending: { label: "Отправка в ERP", tone: "info" },
  completed: { label: "Оформлен", tone: "success" },
};

const ISSUE_CODE_LABELS: Record<string, string> = {
  ARRIVAL_SOURCE_CONFLICT: "Конфликт данных источника",
  ARRIVAL_GROUP_UNASSIGNED: "Не назначен заезд или объект",
  ERP_IG_REQUIREMENTS_CONFLICT: "Конфликт требований ERP",
  DOCUMENT_RETURNED: "Есть возвращённый документ",
  ERP_DELIVERY_NEEDS_ATTENTION: "Ошибка отправки в ERP",
};

function formatIssue(code: string | null | undefined): string {
  if (!code) return "Требует внимания";
  return ISSUE_CODE_LABELS[code] ?? code;
}

const GROUP_PAGE_SIZE = 50;
const PEOPLE_PAGE_SIZE = 50;

export function IgArrivalReviewQueue({
  onSelectCandidate,
  className = "",
}: IgArrivalReviewQueueProps) {
  const profile = useGetMe();
  const permissions = profile.data?.permissions ?? {};
  const hasIgAccess = ["20011", "20009"].some((rule) =>
    Object.prototype.hasOwnProperty.call(permissions, rule),
  );

  // Group search & pagination
  const [groupSearch, setGroupSearch] = useState("");
  const [groupOffset, setGroupOffset] = useState(0);

  // Selected group state
  const [selectedGroup, setSelectedGroup] = useState<IgArrivalGroupDto | null>(
    null,
  );

  // People search & pagination & status filter
  const [peopleSearch, setPeopleSearch] = useState("");
  const [peopleOffset, setPeopleOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const groupsParams = {
    q: groupSearch.trim() || undefined,
    limit: GROUP_PAGE_SIZE,
    offset: groupOffset,
  };
  const groupsQuery = useListIgArrivalGroups(groupsParams, {
    query: {
      queryKey: getListIgArrivalGroupsQueryKey(groupsParams),
      enabled: hasIgAccess,
    },
  });

  const peopleParams = {
    group: (selectedGroup?.group ?? "assigned") as "assigned" | "issues",
    arrivalDate: selectedGroup?.arrivalDate ?? undefined,
    locationUid: selectedGroup?.locationUid ?? undefined,
    q: peopleSearch.trim() || undefined,
    limit: PEOPLE_PAGE_SIZE,
    offset: peopleOffset,
  };
  const peopleQuery = useListIgArrivalPeople(peopleParams, {
    query: {
      queryKey: getListIgArrivalPeopleQueryKey(peopleParams),
      enabled: hasIgAccess && Boolean(selectedGroup),
    },
  });

  const groups = groupsQuery.data?.items ?? [];
  const assignedGroups = useMemo(
    () => groups.filter((g) => g.group === "assigned"),
    [groups],
  );
  const issueGroups = useMemo(
    () => groups.filter((g) => g.group === "issues"),
    [groups],
  );

  // Group assigned groups by arrivalDate
  const groupedByDate = useMemo(() => {
    const map = new Map<string, IgArrivalGroupDto[]>();
    for (const group of assignedGroups) {
      const key = group.arrivalDate ?? "UNSPECIFIED";
      const list = map.get(key) ?? [];
      list.push(group);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [assignedGroups]);

  // Filtered people
  const rawPeople = peopleQuery.data?.items ?? [];
  const filteredPeople = useMemo(() => {
    if (statusFilter === "ALL") return rawPeople;
    if (statusFilter === "needsAttention") {
      return rawPeople.filter((p) => p.needsAttention || p.state === "CONFLICT");
    }
    return rawPeople.filter((p) => p.primaryStatus === statusFilter);
  }, [rawPeople, statusFilter]);

  if (!hasIgAccess) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-6 text-sm text-[var(--muted-foreground)]"
      >
        Нет доступа к проверке документов иностранных граждан. Требуется право
        20011 (EDO_DOCUMENT_REVIEW_IG) или 20009.
      </div>
    );
  }

  // View: Participants of selected group
  if (selectedGroup) {
    const isAssigned = selectedGroup.group === "assigned";
    const groupTitle = isAssigned
      ? selectedGroup.locationName || "Объект не указан"
      : "Проблемные и нераспределённые записи";
    const groupSubtitle = isAssigned && selectedGroup.arrivalDate
      ? `Заезд от ${formatDateRu(selectedGroup.arrivalDate)}`
      : "Записи с конфликтами источника или без заезда";

    return (
      <div className={`space-y-4 ${className}`}>
        {/* Back navigation & group header */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedGroup(null);
                setPeopleSearch("");
                setPeopleOffset(0);
                setStatusFilter("ALL");
              }}
              className="gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Ко всем заездам
            </Button>
            <div>
              <h2 className="text-base font-semibold text-[var(--foreground)]">
                {groupTitle}
              </h2>
              <p className="text-xs text-[var(--muted-foreground)]">
                {groupSubtitle}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void peopleQuery.refetch()}
            disabled={peopleQuery.isFetching}
            className="gap-1.5"
          >
            <RefreshCw
              className={`h-4 w-4 ${peopleQuery.isFetching ? "animate-spin" : ""}`}
            />
            Обновить
          </Button>
        </div>

        {/* Selected group summary metric badges */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-xs">
          <Badge tone="default">Всего: {selectedGroup.total}</Badge>
          <Badge tone="default">Ожидают: {selectedGroup.waitingDocuments}</Badge>
          <Badge tone="purple">На проверке: {selectedGroup.inReview}</Badge>
          <Badge tone="danger">Возвращены: {selectedGroup.returned}</Badge>
          <Badge tone="success">Подтверждены: {selectedGroup.confirmed}</Badge>
          <Badge tone="info">Отправка в ERP: {selectedGroup.sending}</Badge>
          <Badge tone="success">Оформлены: {selectedGroup.completed}</Badge>
          {selectedGroup.needsAttention > 0 && (
            <Badge tone="warning" className="gap-1 font-semibold">
              <AlertTriangle className="h-3 w-3" />
              Внимание: {selectedGroup.needsAttention}
            </Badge>
          )}
        </div>

        {/* Search & Status filter controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[240px] max-w-sm flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-[var(--muted-foreground)]" />
            <input
              type="search"
              placeholder="Поиск участников по ФИО или 1С…"
              value={peopleSearch}
              onChange={(e) => {
                setPeopleSearch(e.target.value);
                setPeopleOffset(0);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pl-8 pr-3 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: "ALL", label: "Все" },
              { id: "waitingDocuments", label: "Ожидают документов" },
              { id: "inReview", label: "На проверке" },
              { id: "returned", label: "Возвращены" },
              { id: "sending", label: "Отправка в ERP" },
              { id: "completed", label: "Оформлены" },
              { id: "needsAttention", label: "Требуют внимания" },
            ].map((tab) => (
              <Button
                key={tab.id}
                size="sm"
                variant={statusFilter === tab.id ? "default" : "outline"}
                onClick={() => setStatusFilter(tab.id)}
                className="text-xs"
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Loading state */}
        {peopleQuery.isLoading && (
          <div
            role="status"
            className="flex items-center justify-center p-12 text-sm text-[var(--muted-foreground)]"
          >
            <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
            Загрузка участников заезда…
          </div>
        )}

        {/* Error state */}
        {peopleQuery.isError && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-4 text-sm text-[var(--foreground)]"
          >
            <div className="flex items-center justify-between">
              <span>Не удалось загрузить участников заезда.</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void peopleQuery.refetch()}
              >
                Повторить
              </Button>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!peopleQuery.isLoading &&
          !peopleQuery.isError &&
          filteredPeople.length === 0 && (
            <EmptyState
              title="Участники не найдены"
              description={
                peopleSearch || statusFilter !== "ALL"
                  ? "По заданным условиям поиска или фильтра участников нет."
                  : "В этой группе пока нет участников."
              }
              action={
                peopleSearch || statusFilter !== "ALL" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPeopleSearch("");
                      setStatusFilter("ALL");
                    }}
                  >
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          )}

        {/* Participants table */}
        {!peopleQuery.isLoading &&
          !peopleQuery.isError &&
          filteredPeople.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--background)]">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--muted)]/50 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    <th className="px-4 py-3">ФИО участника</th>
                    <th className="px-3 py-3">Код 1С</th>
                    <th className="px-3 py-3">Статус</th>
                    <th className="px-3 py-3">Документы</th>
                    <th className="px-3 py-3">Внимание / Проблема</th>
                    <th className="px-4 py-3 text-right">Действие</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {filteredPeople.map((person) => {
                    const statusConfig =
                      PRIMARY_STATUS_CONFIG[person.primaryStatus] ?? {
                        label: person.primaryStatus,
                        tone: "default",
                      };
                    const initials = candidateInitials(person.fullName);
                    const hasAttention =
                      person.needsAttention || person.state === "CONFLICT";

                    return (
                      <tr
                        key={person.personUid}
                        className="transition-colors hover:bg-[var(--muted)]/40"
                      >
                        {/* Full name & avatar */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-[11px] font-semibold text-[var(--primary)]">
                              {initials}
                            </span>
                            <div>
                              <div className="font-medium text-[var(--foreground)]">
                                {person.fullName?.trim() || "Без имени"}
                              </div>
                              {person.arrivalMemberUid && (
                                <div className="text-[10px] text-[var(--muted-foreground)]">
                                  UID: {person.arrivalMemberUid.slice(0, 8)}…
                                </div>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* 1C code */}
                        <td className="px-3 py-3 font-mono text-[11px] text-[var(--muted-foreground)]">
                          {person.code1c || "—"}
                        </td>

                        {/* Primary status badge */}
                        <td className="px-3 py-3">
                          <Badge tone={statusConfig.tone}>
                            {statusConfig.label}
                          </Badge>
                          {/* NOTE: Operator queue STRICTLY must NOT contain an upload button */}
                        </td>

                        {/* Documents progress */}
                        <td className="px-3 py-3">
                          <div className="space-y-0.5">
                            <div className="text-[11px] text-[var(--foreground)]">
                              Подтверждено: {person.confirmedDocuments} /{" "}
                              {person.approvedDocuments} одобрено
                            </div>
                            {person.employmentConfirmed && (
                              <div className="flex items-center gap-1 text-[10px] font-medium text-[var(--success)]">
                                <CheckCircle2 className="h-3 w-3" />
                                Трудоустройство подтверждено
                              </div>
                            )}
                          </div>
                        </td>

                        {/* Attention / issue */}
                        <td className="px-3 py-3">
                          {hasAttention ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {person.state === "CONFLICT" && (
                                <Badge tone="danger">Конфликт заезда</Badge>
                              )}
                              {person.issueCode && (
                                <Badge
                                  tone="warning"
                                  className="gap-1 font-normal"
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  {formatIssue(person.issueCode)}
                                </Badge>
                              )}
                              {!person.issueCode && person.state !== "CONFLICT" && (
                                <Badge
                                  tone="warning"
                                  className="gap-1 font-normal"
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  Требует внимания
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-[11px] text-[var(--muted-foreground)]">
                              —
                            </span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3 text-right">
                          {person.candidateId ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                onSelectCandidate(person.candidateId!)
                              }
                              className="gap-1 text-xs"
                            >
                              Карточка
                              <ChevronRight className="h-3 w-3" />
                            </Button>
                          ) : (
                            <span className="text-[11px] text-[var(--muted-foreground)]">
                              Нет профиля
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        {/* Pagination for people */}
        {(peopleOffset > 0 || peopleQuery.data?.nextOffset != null) && (
          <div className="flex items-center justify-between pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setPeopleOffset((prev) => Math.max(0, prev - PEOPLE_PAGE_SIZE))
              }
              disabled={peopleOffset === 0 || peopleQuery.isFetching}
            >
              Предыдущая
            </Button>
            <span className="text-xs text-[var(--muted-foreground)]">
              Показано с {peopleOffset + 1}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (peopleQuery.data?.nextOffset != null) {
                  setPeopleOffset(peopleQuery.data.nextOffset);
                }
              }}
              disabled={
                peopleQuery.data?.nextOffset == null || peopleQuery.isFetching
              }
            >
              Следующая
            </Button>
          </div>
        )}
      </div>
    );
  }

  // View: List of arrival groups
  return (
    <div className={`space-y-6 ${className}`}>
      {/* Search & refresh bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[260px] max-w-md flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-[var(--muted-foreground)]" />
          <input
            type="search"
            placeholder="Поиск заездов по ФИО участника или 1С…"
            value={groupSearch}
            onChange={(e) => {
              setGroupSearch(e.target.value);
              setGroupOffset(0);
            }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pl-8 pr-3 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void groupsQuery.refetch()}
          disabled={groupsQuery.isFetching}
          className="gap-1.5"
        >
          <RefreshCw
            className={`h-4 w-4 ${groupsQuery.isFetching ? "animate-spin" : ""}`}
          />
          Обновить
        </Button>
      </div>

      {/* Loading state for groups */}
      {groupsQuery.isLoading && (
        <div
          role="status"
          className="flex items-center justify-center p-12 text-sm text-[var(--muted-foreground)]"
        >
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          Загрузка списочных заездов…
        </div>
      )}

      {/* Error state for groups */}
      {groupsQuery.isError && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-4 text-sm text-[var(--foreground)]"
        >
          <div className="flex items-center justify-between">
            <span>Не удалось загрузить списки заездов.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void groupsQuery.refetch()}
            >
              Повторить
            </Button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!groupsQuery.isLoading && !groupsQuery.isError && groups.length === 0 && (
        <EmptyState
          title="Заезды не найдены"
          description={
            groupSearch
              ? "По вашему запросу заезды не найдены. Попробуйте изменить строку поиска."
              : "На текущий момент нет активных заездов иностранных граждан."
          }
          action={
            groupSearch ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setGroupSearch("")}
              >
                Сбросить поиск
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Issues Section: groups with group === "issues" */}
      {issueGroups.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />
            <h2 className="text-sm font-semibold text-[var(--foreground)]">
              Проблемные и нераспределённые записи ({issueGroups.length})
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {issueGroups.map((issueGroup, idx) => (
              <Card
                key={`issue-${idx}`}
                className="border-[var(--warning)]/40 bg-[var(--warning)]/5 transition-shadow hover:shadow-md"
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--foreground)]">
                        Конфликты и ошибки данных
                      </h3>
                      <p className="text-xs text-[var(--muted-foreground)]">
                        Не назначен заезд, объект или конфликт источника
                      </p>
                    </div>
                    <Badge tone="danger">Проблемы</Badge>
                  </div>

                  {/* Counters */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded bg-[var(--background)] p-2">
                      <div className="text-[10px] text-[var(--muted-foreground)]">
                        Всего записей
                      </div>
                      <div className="text-base font-bold text-[var(--foreground)]">
                        {issueGroup.total}
                      </div>
                    </div>
                    <div className="rounded bg-[var(--background)] p-2">
                      <div className="text-[10px] text-[var(--danger)]">
                        Требуют внимания
                      </div>
                      <div className="text-base font-bold text-[var(--danger)]">
                        {issueGroup.needsAttention}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1 text-[11px]">
                    <Badge tone="default">Ожидают: {issueGroup.waitingDocuments}</Badge>
                    <Badge tone="purple">Проверка: {issueGroup.inReview}</Badge>
                    <Badge tone="danger">Возврат: {issueGroup.returned}</Badge>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSelectedGroup(issueGroup);
                      setPeopleOffset(0);
                      setPeopleSearch("");
                      setStatusFilter("ALL");
                    }}
                    className="w-full gap-1.5 text-xs"
                  >
                    Открыть проблемный список ({issueGroup.total})
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Assigned Groups Section: grouped by arrivalDate */}
      {groupedByDate.length > 0 && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-[var(--primary)]" />
            <h2 className="text-sm font-semibold text-[var(--foreground)]">
              Заезды по датам и объектам
            </h2>
          </div>

          {groupedByDate.map(([dateKey, locationGroups]) => (
            <div key={dateKey} className="space-y-3">
              <div className="flex items-center gap-2 border-b border-[var(--border)] pb-1.5">
                <CalendarDays className="h-4 w-4 text-[var(--muted-foreground)]" />
                <span className="text-xs font-semibold text-[var(--foreground)]">
                  {dateKey === "UNSPECIFIED"
                    ? "Дата не указана"
                    : `Заезд: ${formatDateRu(dateKey)}`}
                </span>
                <Badge tone="default" className="text-[10px]">
                  Объектов: {locationGroups.length}
                </Badge>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {locationGroups.map((group, gIdx) => (
                  <Card
                    key={`${dateKey}-${group.locationUid ?? gIdx}`}
                    className="transition-shadow hover:shadow-md"
                  >
                    <CardContent className="space-y-3 p-4">
                      {/* Object title */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <Building2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--muted-foreground)]" />
                          <div>
                            <h3 className="text-sm font-semibold text-[var(--foreground)]">
                              {group.locationName || "Объект не указан"}
                            </h3>
                            <p className="text-[11px] text-[var(--muted-foreground)]">
                              Всего человек: {group.total}
                            </p>
                          </div>
                        </div>
                        {group.needsAttention > 0 && (
                          <Badge tone="warning" className="gap-1 text-[10px]">
                            <AlertTriangle className="h-3 w-3" />
                            {group.needsAttention}
                          </Badge>
                        )}
                      </div>

                      {/* Counters breakdown */}
                      <div className="flex flex-wrap gap-1 text-[11px]">
                        <Badge tone="default">Ожидают: {group.waitingDocuments}</Badge>
                        <Badge tone="purple">На проверке: {group.inReview}</Badge>
                        <Badge tone="danger">Возвращены: {group.returned}</Badge>
                        <Badge tone="success">Подтверждены: {group.confirmed}</Badge>
                        <Badge tone="info">Отправка в ERP: {group.sending}</Badge>
                        <Badge tone="success">Оформлены: {group.completed}</Badge>
                      </div>

                      {/* Select group button */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedGroup(group);
                          setPeopleOffset(0);
                          setPeopleSearch("");
                          setStatusFilter("ALL");
                        }}
                        className="w-full gap-1.5 text-xs"
                      >
                        Список участников ({group.total})
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination for groups */}
      {(groupOffset > 0 || groupsQuery.data?.nextOffset != null) && (
        <div className="flex items-center justify-between pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setGroupOffset((prev) => Math.max(0, prev - GROUP_PAGE_SIZE))
            }
            disabled={groupOffset === 0 || groupsQuery.isFetching}
          >
            Предыдущие заезды
          </Button>
          <span className="text-xs text-[var(--muted-foreground)]">
            Показано с {groupOffset + 1}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (groupsQuery.data?.nextOffset != null) {
                setGroupOffset(groupsQuery.data.nextOffset);
              }
            }}
            disabled={
              groupsQuery.data?.nextOffset == null || groupsQuery.isFetching
            }
          >
            Следующие заезды
          </Button>
        </div>
      )}
    </div>
  );
}
