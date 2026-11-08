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
const requirementLabels: Record<string, string> = {
  REVIEW: "Проверить документы",
  RETURNED: "Ожидается исправление",
  ATTENTION: "Требует уточнения",
  PROCESSING: "Документы обрабатываются",
  MISSING: "Ожидаются документы",
  COMPLETE: "Все обязательные документы приняты",
  UNKNOWN: "Уточнить комплект",
};
const inputClass =
  "h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-sm text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const headerClass =
  "sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-left text-sm font-semibold";
const cellClass = "border-b border-[var(--border)] px-3 py-2 align-top text-sm";
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
function stackMap(value: unknown): Record<string, string[]> {
  try {
    return JSON.parse(typeof value === "string" ? value : "{}");
  } catch {
    return {};
  }
}
function documentCount(count: number) {
  const n = count % 100;
  const word =
    n >= 11 && n <= 14
      ? "документов"
      : n % 10 === 1
        ? "документ"
        : n % 10 >= 2 && n % 10 <= 4
          ? "документа"
          : "документов";
  return `${count} ${word}`;
}
function archivePeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const day = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { igDateFrom: day(start), igDateTo: day(now), igPeriod: "custom" };
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
        igGroupStack: undefined,
        igPageStacks: undefined,
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
  const defaultArchive =
    search.igArchive === "archive" &&
    !search.igPeriod &&
    !search.igDateFrom &&
    !search.igDateTo;
  const archiveDefaults = useMemo(archivePeriod, []);
  useEffect(() => {
    if (defaultArchive) changeFilters(archiveDefaults, true);
  }, [defaultArchive]);
  const common: CommonParams = {
    archive: search.igArchive === "archive" ? "archive" : "current",
    q: search.igQ as string | undefined,
    dateFrom: (search.igDateFrom ??
      (defaultArchive ? archiveDefaults.igDateFrom : undefined)) as
      | string
      | undefined,
    dateTo: (search.igDateTo ??
      (defaultArchive ? archiveDefaults.igDateTo : undefined)) as
      | string
      | undefined,
    locationUid: search.igLocationUid as string | undefined,
    requirementsAction:
      search.igRequirementsAction as CommonParams["requirementsAction"],
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
    cursor: defaultArchive
      ? undefined
      : (search.igCursor as string | undefined),
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
  const openGroups = defaultArchive ? [] : arrayValue(search.igGroups);
  const pages = pageValue(search.igPages);
  const groupStack = arrayValue(search.igGroupStack);
  const pageStacks = stackMap(search.igPageStacks);
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
            onChange={(e) =>
              changeFilters({ igDateFrom: e.target.value, igPeriod: "custom" })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Дата по
          <input
            className={inputClass}
            type="date"
            value={common.dateTo ?? ""}
            onChange={(e) =>
              changeFilters({ igDateTo: e.target.value, igPeriod: "custom" })
            }
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
          Что требуется
          <select
            className={inputClass}
            value={common.requirementsAction ?? ""}
            onChange={(e) =>
              changeFilters({
                igRequirementsAction: e.target.value,
                igDocumentStatus: undefined,
              })
            }
          >
            <option value="">Все</option>
            {Object.entries(requirementLabels).map(([value, label]) => (
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
      <Button
        size="sm"
        variant={!common.dateFrom && !common.dateTo ? "default" : "outline"}
        aria-pressed={!common.dateFrom && !common.dateTo}
        onClick={() =>
          changeFilters({
            igDateFrom: undefined,
            igDateTo: undefined,
            igPeriod: "all",
          })
        }
      >
        Все даты
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" aria-label="Период реестра">
          <Button
            size="sm"
            variant={common.archive === "current" ? "default" : "outline"}
            onClick={() =>
              changeFilters({
                igArchive: undefined,
                igDateFrom: undefined,
                igDateTo: undefined,
                igPeriod: "all",
              })
            }
          >
            Текущие
          </Button>
          <Button
            size="sm"
            variant={common.archive === "archive" ? "default" : "outline"}
            onClick={() =>
              changeFilters({ igArchive: "archive", ...archivePeriod() })
            }
          >
            Архив
          </Button>
        </div>
        <p className="text-xs text-[var(--muted-foreground)]">
          {groups.data?.sync.lastCompletedAt
            ? `Последнее обновление данных: ${new Date(groups.data.sync.lastCompletedAt).toLocaleString("ru-RU")}`
            : "Данные ещё не обновлялись"}
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
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr>
                <th className={`${headerClass} left-0 z-30 min-w-64`}>
                  Сотрудник
                </th>
                <th className={headerClass}>Документы</th>
                <th className={headerClass}>Что требуется</th>
                <th className={headerClass}>Действие</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(([date, items]) => (
                <Fragment key={date}>
                  <tr className="bg-[var(--muted)]">
                    <th
                      colSpan={4}
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
                            colSpan={4}
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
                            canGoBack={Boolean(pages[group.groupKey])}
                            onBack={() => {
                              const stack = pageStacks[group.groupKey] ?? [];
                              update({
                                igPages: JSON.stringify({
                                  ...pages,
                                  [group.groupKey]: stack.at(-1) ?? "",
                                }),
                                igPageStacks: JSON.stringify({
                                  ...pageStacks,
                                  [group.groupKey]: stack.slice(0, -1),
                                }),
                              });
                            }}
                            onNext={(cursor) =>
                              update({
                                igPages: JSON.stringify({
                                  ...pages,
                                  [group.groupKey]: cursor,
                                }),
                                igPageStacks: JSON.stringify({
                                  ...pageStacks,
                                  [group.groupKey]: [
                                    ...(pageStacks[group.groupKey] ?? []),
                                    pages[group.groupKey] ?? "",
                                  ].slice(-50),
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
                igCursor: groupStack.at(-1) || undefined,
                igGroupStack: JSON.stringify(groupStack.slice(0, -1)),
                igGroups: undefined,
                igPages: undefined,
                igPageStacks: undefined,
              })
            }
          >
            Назад к объектам
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!groups.data?.nextCursor}
            onClick={() =>
              update({
                igCursor: groups.data?.nextCursor,
                igGroupStack: JSON.stringify(
                  [...groupStack, search.igCursor ?? ""].slice(-50),
                ),
                igGroups: undefined,
                igPages: undefined,
                igPageStacks: undefined,
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
  canGoBack,
  onBack,
  onNext,
  onSelectCandidate,
}: {
  groupKey: string;
  common: CommonParams;
  cursor?: string;
  canGoBack: boolean;
  onBack: () => void;
  onNext: (cursor: string) => void;
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
        <td colSpan={4} className={cellClass} role="status">
          Загрузка участников…
        </td>
      </tr>
    );
  if (people.isError && !people.data)
    return (
      <tr>
        <td colSpan={4} className={cellClass} role="alert">
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
          <td colSpan={4} className={cellClass} role="alert">
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
            {person.fullName || "Без имени"}
            {person.participationStatus !== "CURRENT" && (
              <span className="mt-1 block">
                <Badge>
                  {person.participationStatus === "CANCELLED"
                    ? "Отменён"
                    : person.participationStatus === "HISTORICAL"
                      ? "Исторический"
                      : "Требует уточнения"}
                </Badge>
                {common.archive === "archive" && (
                  <span className="ml-2 font-normal text-[var(--muted-foreground)]">
                    Данные текущего профиля
                  </span>
                )}
              </span>
            )}
          </th>
          <td className={cellClass}>
            {person.requirements.known &&
            person.requirements.required !== null &&
            person.requirements.accepted !== null ? (
              <>
                <span className="font-medium">
                  {person.requirements.accepted} из{" "}
                  {person.requirements.required}
                </span>
                <span className="block text-[var(--muted-foreground)]">
                  обязательных принято
                </span>
              </>
            ) : (
              "Комплект не определён"
            )}
          </td>
          <td className={cellClass}>
            {!person.candidateId
              ? "Нет связанного профиля. Обратитесь к ответственному за привязку кандидатов."
              : person.deliveryNeedsAttention &&
                  ["COMPLETE", "UNKNOWN"].includes(
                    person.requirements.nextAction,
                  )
                ? "Передача документов в 1С не подтверждена"
                : person.requirements.nextAction === "REVIEW"
                  ? `Проверить ${documentCount(person.reviewAvailable)}`
                  : person.requirements.nextAction === "MISSING" &&
                      person.requirements.missing !== null
                    ? `Ожидается ${documentCount(person.requirements.missing)}`
                    : (requirementLabels[person.requirements.nextAction] ??
                      "Требует уточнения")}
            {person.deliveryNeedsAttention &&
              !["COMPLETE", "UNKNOWN"].includes(
                person.requirements.nextAction,
              ) && (
                <span className="block text-[var(--muted-foreground)]">
                  Передача документов в 1С не подтверждена
                </span>
              )}
            {(person.requirements.returned &&
              person.requirements.nextAction !== "RETURNED") ||
            (person.requirements.missing &&
              person.requirements.nextAction !== "MISSING") ? (
              <span className="block text-[var(--muted-foreground)]">
                {[
                  person.requirements.returned &&
                  person.requirements.nextAction !== "RETURNED"
                    ? `Возвращено: ${person.requirements.returned}`
                    : null,
                  person.requirements.missing &&
                  person.requirements.nextAction !== "MISSING"
                    ? `Ожидается: ${person.requirements.missing}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
            {person.personState === "CONFLICT" && (
              <span className="block text-[var(--muted-foreground)]">
                Данные заезда требуют уточнения
              </span>
            )}
          </td>
          <td className={cellClass}>
            {person.candidateId && person.action !== "NONE" && (
              <Button
                size="sm"
                variant="outline"
                aria-label={`${person.action === "REVIEW" ? "Проверить" : "Открыть карточку"}: ${person.fullName || "Без имени"}`}
                onClick={() =>
                  onSelectCandidate(person.candidateId!, {
                    memberUid: person.arrivalMemberUid ?? undefined,
                    date: person.arrivalDate ?? undefined,
                    location: person.locationName ?? undefined,
                    status: person.participationStatus,
                  })
                }
              >
                {person.action === "REVIEW" ? "Проверить" : "Открыть карточку"}
              </Button>
            )}
          </td>
        </tr>
      ))}
      {!people.data?.items.length && (
        <tr>
          <td colSpan={4} className={cellClass}>
            Нет участников по выбранным фильтрам.
          </td>
        </tr>
      )}
      {(cursor || people.data?.nextCursor) && (
        <tr>
          <td colSpan={4} className={cellClass}>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canGoBack}
                onClick={onBack}
              >
                Назад к участникам
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!people.data?.nextCursor}
                onClick={() => onNext(people.data!.nextCursor!)}
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
