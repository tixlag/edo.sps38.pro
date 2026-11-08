import { Fragment, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useGetMe,
  useListIgArrivalRegistryGroups,
  useListIgArrivalRegistryParticipations,
  getListIgArrivalRegistryGroupsQueryKey,
  getListIgArrivalRegistryParticipationsQueryKey,
  useListIgArrivalRegistryLocations,
  getListIgArrivalRegistryLocationsQueryKey,
} from "@edo/api-client";
import { Badge, Button, EmptyState } from "@edo/ui";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { SearchSelect } from "./SearchSelect";
import { formatDateRu } from "../lib/date-format";
import { parseIgRegistrySearch } from "../lib/ig-registry-search";

export interface IgArrivalReviewQueueProps {
  onSelectCandidate: (candidateId: string, context: ArrivalContext) => void;
  className?: string;
}
export type ArrivalContext = {
  memberUid?: string;
  date?: string;
  location?: string;
  status: string;
};
const issueLabels: Record<string, string> = {
  ARRIVAL_SOURCE_CONFLICT: "Конфликт данных источника",
  ARRIVAL_GROUP_UNASSIGNED: "Не назначен заезд или объект",
  ERP_IG_REQUIREMENTS_CONFLICT: "Конфликт требований ERP",
  DOCUMENT_RETURNED: "Есть возвращённый документ",
  ERP_DELIVERY_NEEDS_ATTENTION: "Ошибка отправки в ERP",
};
const documentLabels: Record<string, string> = {
  UNKNOWN: "Неизвестно",
  NO_DOCUMENTS: "Нет документов",
  IN_PROGRESS: "В работе",
  RETURNED: "Возвращены",
  APPROVED: "Подтверждены",
};
const erpLabels: Record<string, string> = {
  UNKNOWN: "Неизвестно",
  NOT_REQUIRED: "Не требуется",
  PENDING: "Ожидает отправки",
  NEEDS_ATTENTION: "Требует внимания",
  CONFIRMED: "Подтверждена",
};
const oneCLabels: Record<string, string> = { UNKNOWN: "Неизвестно" };
const employmentLabels: Record<string, string> = {
  UNKNOWN: "Неизвестно",
  IN_PROGRESS: "В работе",
  DOCUMENTS_COMPLETED: "Документы завершены",
};
const participationLabels: Record<string, string> = {
  CURRENT: "Текущий",
  HISTORICAL: "Исторический",
  CANCELLED: "Отменён",
  ISSUE: "Требует внимания",
};
const inputClass =
  "h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const headerClass =
  "sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-left text-xs font-semibold";
const cellClass = "border-b border-[var(--border)] px-3 py-2 align-top text-xs";
const frozenClass = "sticky left-0 z-10 bg-[var(--background)]";

type CommonParams = NonNullable<
  Parameters<typeof useListIgArrivalRegistryGroups>[0]
>;
function arrayValue(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(
      typeof value === "string" ? value : "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}
function pageValue(value: unknown): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      typeof value === "string" ? value : "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}
function dateLabel(date: string) {
  return date === "issues"
    ? "Без распределения"
    : date === "none"
      ? "Дата не указана"
      : formatDateRu(date);
}

export function IgArrivalReviewQueue({
  onSelectCandidate,
  className = "",
}: IgArrivalReviewQueueProps) {
  const client = useQueryClient();
  const profile = useGetMe();
  const allowed = ["20011", "20009"].some((rule) =>
    Object.prototype.hasOwnProperty.call(profile.data?.permissions ?? {}, rule),
  );
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = parseIgRegistrySearch(raw);
  const navigate = useNavigate();
  const update = (patch: Record<string, unknown>, replace = false) =>
    void navigate({
      to: "/review-ig",
      replace,
      search: (previous: Record<string, unknown>) => {
        const next = { ...previous };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === "") delete next[key];
          else next[key] = value;
        }
        return next;
      },
    });
  const changeFilters = (patch: Record<string, unknown>, replace = false) =>
    update(
      {
        ...patch,
        igCursor: undefined,
        igGroups: undefined,
        igDates: undefined,
        igPages: undefined,
      },
      replace,
    );
  const [query, setQuery] = useState(String(search.igQ ?? ""));
  useEffect(() => setQuery(String(search.igQ ?? "")), [search.igQ]);
  useEffect(() => {
    if (query.trim() === (search.igQ ?? "")) return;
    const timer = window.setTimeout(
      () => changeFilters({ igQ: query.trim() || undefined }, true),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [query, search.igQ]);
  const common: CommonParams = {
    archive: search.igArchive === "archive" ? "archive" : "current",
    q: search.igQ as string | undefined,
    dateFrom: search.igDateFrom as string | undefined,
    dateTo: search.igDateTo as string | undefined,
    locationUid: search.igLocationUid as string | undefined,
    documentStatus: search.igDocumentStatus as CommonParams["documentStatus"],
    needsAttention: search.igNeedsAttention === true ? true : undefined,
    limit: 50,
  };
  const [locationQuery, setLocationQuery] = useState("");
  const locationParams = {
    archive: common.archive,
    q: locationQuery.trim() || undefined,
    limit: 50,
  };
  const locations = useListIgArrivalRegistryLocations(locationParams, {
    query: {
      queryKey: getListIgArrivalRegistryLocationsQueryKey(locationParams),
      enabled: allowed,
    },
  });
  const selectedLocationParams = {
    archive: common.archive,
    locationUid: common.locationUid,
    limit: 1,
  };
  const selectedLocation = useListIgArrivalRegistryLocations(
    selectedLocationParams,
    {
      query: {
        queryKey: getListIgArrivalRegistryLocationsQueryKey(
          selectedLocationParams,
        ),
        enabled: allowed && Boolean(common.locationUid),
      },
    },
  );
  const invalidRange = Boolean(
    common.dateFrom && common.dateTo && common.dateFrom > common.dateTo,
  );
  const groupParams = {
    ...common,
    cursor: search.igCursor as string | undefined,
  };
  const groups = useListIgArrivalRegistryGroups(groupParams, {
    query: {
      queryKey: getListIgArrivalRegistryGroupsQueryKey(groupParams),
      enabled: allowed && !invalidRange,
    },
  });
  const grouped = useMemo(() => {
    const dates = new Map<string, NonNullable<typeof groups.data>["items"]>();
    for (const group of groups.data?.items ?? []) {
      const key =
        group.group === "issues" ? "issues" : (group.arrivalDate ?? "none");
      const existing = dates.get(key) ?? [];
      existing.push(group);
      dates.set(key, existing);
    }
    return [...dates.entries()];
  }, [groups.data]);
  const openGroups = arrayValue(search.igGroups);
  const pages = pageValue(search.igPages);
  const openDates =
    search.igDates === undefined
      ? grouped.map(([date]) => date)
      : arrayValue(search.igDates);
  const toggle = (
    key: "igGroups" | "igDates",
    current: string[],
    value: string,
  ) =>
    update({
      [key]: JSON.stringify(
        current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      ),
    });
  if (profile.isLoading)
    return (
      <p role="status" className="py-4 text-sm">
        Проверка доступа…
      </p>
    );
  if (!allowed)
    return (
      <div
        role="alert"
        className="rounded-md border border-[var(--border)] p-4 text-sm"
      >
        Нет доступа к проверке документов иностранных граждан.
      </div>
    );
  return (
    <div className={`space-y-3 ${className}`}>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
          Поиск по ФИО или коду 1С
          <input
            className={inputClass}
            type="search"
            maxLength={128}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Дата с
          <input
            className={inputClass}
            type="date"
            value={common.dateFrom ?? ""}
            onChange={(e) => changeFilters({ igDateFrom: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Дата по
          <input
            className={inputClass}
            type="date"
            value={common.dateTo ?? ""}
            onChange={(e) => changeFilters({ igDateTo: e.target.value })}
          />
        </label>
        <div className="flex min-w-48 flex-col gap-1 text-xs font-medium">
          <span>Объект</span>
          <SearchSelect
            label="Объект"
            placeholder="Все объекты"
            value={common.locationUid}
            selectedLabel={
              selectedLocation.data?.items[0]?.locationName ?? undefined
            }
            options={(locations.data?.items ?? []).map((item) => ({
              value: item.locationUid,
              label: item.locationName ?? "Без названия",
            }))}
            onSearchChange={setLocationQuery}
            onChange={(value) => changeFilters({ igLocationUid: value })}
            isLoading={locations.isLoading}
            isError={locations.isError}
            onRetry={() => void locations.refetch()}
            emptyText="Объект не найден"
          />
          {locations.data?.nextCursor && (
            <span className="text-[var(--muted-foreground)]">
              Уточните название для поиска остальных объектов.
            </span>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Документы
          <select
            className={inputClass}
            value={common.documentStatus ?? ""}
            onChange={(e) =>
              changeFilters({ igDocumentStatus: e.target.value })
            }
          >
            <option value="">Все</option>
            {Object.entries(documentLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={common.needsAttention === true}
            onChange={(e) =>
              changeFilters({ igNeedsAttention: e.target.checked || undefined })
            }
          />
          Требуют внимания
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={groups.isFetching}
          onClick={() => {
            void groups.refetch();
            void client.invalidateQueries({
              queryKey: getListIgArrivalRegistryParticipationsQueryKey({
                groupKey: "",
              }).slice(0, 1),
            });
          }}
        >
          <RefreshCw size={14} /> Обновить
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" aria-label="Период реестра">
          <Button
            size="sm"
            variant={common.archive === "current" ? "default" : "outline"}
            onClick={() => changeFilters({ igArchive: undefined })}
          >
            Текущие
          </Button>
          <Button
            size="sm"
            variant={common.archive === "archive" ? "default" : "outline"}
            onClick={() => changeFilters({ igArchive: "archive" })}
          >
            Архив
          </Button>
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">
          {groups.data?.sync.lastCompletedAt
            ? `Последний завершённый проход: ${new Date(groups.data.sync.lastCompletedAt).toLocaleString("ru-RU")}; актуальность отдельных записей не подтверждена`
            : "Последний завершённый проход отсутствует; актуальность отдельных записей не подтверждена"}
        </p>
      </div>
      {groups.isError && groups.data && (
        <div role="alert" className="text-sm">
          Не удалось обновить реестр; показаны сохранённые данные.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void groups.refetch()}
          >
            Повторить
          </Button>
        </div>
      )}
      {invalidRange ? (
        <p role="alert" className="text-sm">
          Начало периода должно быть не позже конца.
        </p>
      ) : groups.isLoading ? (
        <p role="status" className="py-4 text-sm">
          Загрузка реестра…
        </p>
      ) : groups.isError && !groups.data ? (
        <div role="alert" className="text-sm">
          Не удалось загрузить реестр.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void groups.refetch()}
          >
            Повторить
          </Button>
        </div>
      ) : !grouped.length ? (
        <EmptyState
          title="Участники не найдены"
          description="Измените фильтры или выберите другой период."
        />
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-[var(--border)]">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr>
                <th className={`${headerClass} left-0 z-30 min-w-64`}>
                  Дата / объект / участник
                </th>
                <th className={headerClass}>Код 1С</th>
                <th className={headerClass}>Участие</th>
                <th className={headerClass}>Документы</th>
                <th className={headerClass}>Доставка ERP</th>
                <th className={headerClass}>Завершение в ЭДО</th>
                <th className={headerClass}>Кадры 1С</th>
                <th className={headerClass}>Внимание</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([date, items]) => (
                <Fragment key={date}>
                  <tr className="bg-[var(--muted)]">
                    <th
                      colSpan={8}
                      scope="rowgroup"
                      className="border-b border-[var(--border)] p-0 text-left"
                    >
                      <button
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                        aria-expanded={openDates.includes(date)}
                        onClick={() => toggle("igDates", openDates, date)}
                      >
                        {openDates.includes(date) ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                        {dateLabel(date)}
                      </button>
                    </th>
                  </tr>
                  {openDates.includes(date) &&
                    items.map((group) => (
                      <Fragment key={group.groupKey}>
                        <tr>
                          <th
                            colSpan={8}
                            scope="rowgroup"
                            className="border-b border-[var(--border)] bg-[var(--background)] p-0 text-left"
                          >
                            <button
                              className="flex w-full flex-wrap items-center gap-2 py-2 pl-8 pr-3 text-sm font-medium hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                              aria-expanded={openGroups.includes(
                                group.groupKey,
                              )}
                              onClick={() =>
                                toggle("igGroups", openGroups, group.groupKey)
                              }
                            >
                              {openGroups.includes(group.groupKey) ? (
                                <ChevronDown size={15} />
                              ) : (
                                <ChevronRight size={15} />
                              )}
                              {group.locationName ||
                                (group.group === "issues"
                                  ? "Проблемные записи"
                                  : "Объект не указан")}{" "}
                              <span className="text-xs font-normal text-[var(--muted-foreground)]">
                                {group.participationCount ===
                                group.totalParticipationCount
                                  ? `${group.participationCount} участников`
                                  : `${group.participationCount} из ${group.totalParticipationCount} участников`}
                                {group.needsAttentionCount
                                  ? ` · требуют внимания: ${group.needsAttentionCount}`
                                  : ""}
                              </span>
                            </button>
                          </th>
                        </tr>
                        {openGroups.includes(group.groupKey) && (
                          <ParticipationRows
                            groupKey={group.groupKey}
                            common={common}
                            cursor={pages[group.groupKey]}
                            onPage={(cursor) =>
                              update({
                                igPages: JSON.stringify({
                                  ...pages,
                                  [group.groupKey]: cursor,
                                }),
                              })
                            }
                            onSelectCandidate={onSelectCandidate}
                          />
                        )}
                      </Fragment>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(search.igCursor || groups.data?.nextCursor) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!search.igCursor}
            onClick={() =>
              update({
                igCursor: undefined,
                igGroups: undefined,
                igPages: undefined,
              })
            }
          >
            В начало
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!groups.data?.nextCursor}
            onClick={() =>
              update({
                igCursor: groups.data?.nextCursor,
                igGroups: undefined,
                igPages: undefined,
              })
            }
          >
            Следующие объекты
          </Button>
        </div>
      )}
    </div>
  );
}

function ParticipationRows({
  groupKey,
  common,
  cursor,
  onPage,
  onSelectCandidate,
}: {
  groupKey: string;
  common: CommonParams;
  cursor?: string;
  onPage: (cursor: string) => void;
  onSelectCandidate: (id: string, context: ArrivalContext) => void;
}) {
  const people = useListIgArrivalRegistryParticipations({
    ...common,
    groupKey,
    cursor,
  });
  if (people.isLoading)
    return (
      <tr>
        <td colSpan={8} className={cellClass} role="status">
          Загрузка участников…
        </td>
      </tr>
    );
  if (people.isError && !people.data)
    return (
      <tr>
        <td colSpan={8} className={cellClass} role="alert">
          Не удалось загрузить участников.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void people.refetch()}
          >
            Повторить
          </Button>
        </td>
      </tr>
    );
  return (
    <>
      {people.isError && people.data && (
        <tr>
          <td colSpan={8} className={cellClass} role="alert">
            Не удалось обновить участников; показаны сохранённые данные.{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void people.refetch()}
            >
              Повторить
            </Button>
          </td>
        </tr>
      )}
      {people.data?.items.map((person) => (
        <tr
          key={person.arrivalMemberUid ?? person.personUid}
          className="hover:bg-[var(--muted)]/40"
        >
          <th
            scope="row"
            className={`${cellClass} ${frozenClass} pl-14 text-left font-medium`}
          >
            {person.candidateId ? (
              <button
                className="text-left underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                onClick={() =>
                  onSelectCandidate(person.candidateId!, {
                    memberUid: person.arrivalMemberUid ?? undefined,
                    date: person.arrivalDate ?? undefined,
                    location: person.locationName ?? undefined,
                    status: person.participationStatus,
                  })
                }
              >
                {person.fullName || "Без имени"}
              </button>
            ) : (
              <>
                {person.fullName || "Без имени"}
                <span className="block font-normal text-[var(--muted-foreground)]">
                  Нет связанного профиля. Обратитесь к ответственному за
                  привязку кандидатов.
                </span>
              </>
            )}
            {person.arrivalDateTime && (
              <span className="block font-normal text-[var(--muted-foreground)]">
                {formatDateRu(person.arrivalDateTime.slice(0, 10))} ·{" "}
                {person.arrivalDateTime.slice(11, 16)}
              </span>
            )}
          </th>
          <td className={cellClass}>{person.code1c || "—"}</td>
          <td className={cellClass}>
            {participationLabels[person.participationStatus] ??
              person.participationStatus}
            {person.participationStatus !== "CURRENT" && (
              <span className="block text-[var(--muted-foreground)]">
                Статусы текущего профиля
              </span>
            )}
          </td>
          <td className={cellClass}>
            <Badge
              tone={person.documentStatus === "RETURNED" ? "danger" : "default"}
            >
              {documentLabels[person.documentStatus] ?? person.documentStatus}
            </Badge>
          </td>
          <td className={cellClass}>
            {erpLabels[person.erpDeliveryStatus] ?? person.erpDeliveryStatus}
          </td>
          <td className={cellClass}>
            {employmentLabels[person.employmentStatus] ??
              person.employmentStatus}
          </td>
          <td className={cellClass}>{oneCLabels[person.oneCEmploymentStatus] ?? "Неизвестно"}</td>
          <td className={cellClass}>
            {person.needsAttention
              ? person.issueCodes
                  .map((code) => issueLabels[code] ?? "Требует уточнения")
                  .join(", ") || "Требует внимания"
              : "—"}
          </td>
        </tr>
      ))}
      {!people.data?.items.length && (
        <tr>
          <td colSpan={8} className={cellClass}>
            Нет участников по выбранным фильтрам.
          </td>
        </tr>
      )}
      {(cursor || people.data?.nextCursor) && (
        <tr>
          <td colSpan={8} className={cellClass}>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!cursor}
                onClick={() => onPage("")}
              >
                В начало
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!people.data?.nextCursor}
                onClick={() => onPage(people.data!.nextCursor!)}
              >
                Следующие участники
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
