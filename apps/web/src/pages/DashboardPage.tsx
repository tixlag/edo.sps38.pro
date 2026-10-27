import {
  useGetDashboard,
  useGetMe,
  type GetDashboardParams,
  type KpiDto,
} from "@edo/api-client";
import {
  Card,
  CardContent,
  CardHeader,
  MetricCard,
  PageHeader,
  Button,
} from "@edo/ui";
import { ActivityItem } from "../components/ActivityItem";
import {
  CheckCircle2,
  FileCheck2,
  AlertTriangle,
  Clock,
  RefreshCw,
} from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatDateTimeRu } from "../lib/date-format";

export const KPI_META: Record<
  string,
  {
    icon: typeof FileCheck2;
    accent: string;
    to?: "/review";
    currentStatus?: "IN_REVIEW" | "RETURNED" | "OCR_FAILED";
  }
> = {
  queue: {
    icon: FileCheck2,
    accent: "var(--info-soft)",
    to: "/review",
    currentStatus: "IN_REVIEW",
  },
  in_review: { icon: Clock, accent: "var(--info-soft)" },
  rework: {
    icon: RefreshCw,
    accent: "var(--purple-soft)",
    to: "/review",
    currentStatus: "RETURNED",
  },
  approved: { icon: CheckCircle2, accent: "var(--success-soft)" },
  ocr_failed: {
    icon: AlertTriangle,
    accent: "var(--warning-soft)",
    to: "/review",
    currentStatus: "OCR_FAILED",
  },
};
const COLORS = [
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--purple)",
  "var(--primary)",
  "var(--muted-foreground)",
];
const CONTROL =
  "rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]";
export function parseDashboardSearch(
  raw: Record<string, unknown>,
): GetDashboardParams {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value : undefined;
  const group = raw.reviewGroup;
  return {
    reviewGroup:
      group === "RU" || group === "IG" || group === "ALL" ? group : undefined,
    managerCode1c: text(raw.managerCode1c),
    managerName: text(raw.managerName),
    managerUnassigned:
      raw.managerUnassigned === true || raw.managerUnassigned === "true"
        ? true
        : undefined,
  };
}
function Donut({ slices }: { slices: { value: number; color: string }[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let accumulated = 0;
  const stops = slices
    .map((slice) => {
      const from = (accumulated / (total || 1)) * 360;
      accumulated += slice.value;
      return `${slice.color} ${from}deg ${(accumulated / (total || 1)) * 360}deg`;
    })
    .join(", ");
  return (
    <div
      aria-hidden="true"
      className="relative h-[120px] w-[120px] shrink-0 rounded-full"
      style={{
        background: total ? `conic-gradient(${stops})` : "var(--border)",
      }}
    >
      <div className="absolute inset-[22px] flex items-center justify-center rounded-full bg-[var(--card)]">
        <span className="font-mono text-[20px] font-bold">{total}</span>
      </div>
    </div>
  );
}
export function DashboardPage() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const params = parseDashboardSearch(raw);
  const profile = useGetMe();
  const { data, isLoading, isError, refetch } = useGetDashboard(params);
  const navigate = useNavigate();
  const has = (rule: string) =>
    !!profile.data?.permissions &&
    [rule, "20009"].some((key) =>
      Object.prototype.hasOwnProperty.call(profile.data!.permissions, key),
    );
  const groups = (["RU", "IG"] as const).filter((group) =>
    has(group === "RU" ? "20002" : "20011"),
  );
  const setFilters = (patch: Record<string, unknown>) =>
    void navigate({
      to: "/",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        ...patch,
      }),
    });
  const manager = params.managerCode1c
    ? `code:${params.managerCode1c}`
    : params.managerName
      ? `name:${params.managerName}`
      : params.managerUnassigned
        ? "unassigned"
        : "";
  const selectedGroup =
    params.reviewGroup && params.reviewGroup !== "ALL"
      ? params.reviewGroup
      : groups.length === 1
        ? groups[0]
        : undefined;
  const metrics = (kpis: KpiDto[], group?: "RU" | "IG") => (
    <div className="grid grid-cols-1 gap-[14px] sm:grid-cols-2 xl:grid-cols-5">
      {kpis.map((kpi) => {
        const meta = KPI_META[kpi.key] ?? KPI_META.queue;
        const Icon = meta.icon;
        return (
          <MetricCard
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
            hint={kpi.hint}
            accent={meta.accent}
            icon={<Icon size={20} />}
            onClick={
              group && meta.to
                ? () =>
                    void navigate({
                      to: group === "RU" ? "/review" : "/review-ig",
                      search: {
                        status: kpi.key === "rework" ? "RETURNED" : "IN_REVIEW",
                        currentStatus: meta.currentStatus,
                        managerCode1c: params.managerCode1c,
                        managerName: params.managerName,
                        managerUnassigned: params.managerUnassigned,
                      },
                    })
                : undefined
            }
          />
        );
      })}
    </div>
  );
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader title="Дашборд" subtitle="Приёмка документов кандидатов" />
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Отдел
          <select
            className={CONTROL}
            aria-label="Отдел"
            value={params.reviewGroup ?? "ALL"}
            onChange={(event) =>
              setFilters({
                reviewGroup: event.target.value,
                managerCode1c: undefined,
                managerName: undefined,
                managerUnassigned: undefined,
              })
            }
          >
            <option value="ALL">Все доступные отделы</option>
            {groups.map((group) => (
              <option key={group} value={group}>
                {group === "RU" ? "РУ" : "ИГ"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs font-semibold">
          Менеджер
          <select
            className={CONTROL}
            aria-label="Менеджер"
            value={manager}
            onChange={(event) => {
              const value = event.target.value;
              setFilters({
                managerCode1c: value.startsWith("code:")
                  ? value.slice(5)
                  : undefined,
                managerName: value.startsWith("name:")
                  ? value.slice(5)
                  : undefined,
                managerUnassigned: value === "unassigned" ? true : undefined,
              });
            }}
          >
            <option value="">Все менеджеры</option>
            {manager &&
              !data?.managers.some((item) => item.key === manager) && (
                <option value={manager}>
                  {params.managerName ??
                    params.managerCode1c ??
                    "Без менеджера"}
                </option>
              )}
            {(data?.managers ?? []).map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
                {item.code1c
                  ? ` (${item.code1c})`
                  : item.key === "unassigned"
                    ? ""
                    : " · без кода"}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          onClick={() => void navigate({ to: "/", search: {} })}
        >
          Сбросить фильтры
        </Button>
      </div>
      {isLoading && <p role="status">Загрузка дашборда…</p>}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>
            Не удалось загрузить данные. Проверьте фильтры или повторите запрос.
          </p>
          <Button variant="outline" onClick={() => void refetch()}>
            Повторить
          </Button>
        </div>
      )}
      {data && (
        <>
          {!data.sections.length && (
            <p className="text-sm text-[var(--muted-foreground)]">
              Приёмка документов доступна сотрудникам с правом проверки РУ или
              ИГ.
            </p>
          )}
          {!!data.sections.length && (
            <>
              <section aria-label="Итого" className="flex flex-col gap-2">
                <h2 className="text-[15px] font-bold">
                  {data.sections.length > 1
                    ? "Итого по отделам"
                    : selectedGroup === "IG"
                      ? "Проверка документов ИГ"
                      : "Проверка документов РУ"}
                </h2>
                {metrics(data.kpis, selectedGroup)}
              </section>
              {data.sections.length > 1 &&
                data.sections.map((section) => (
                  <section
                    key={section.reviewGroup}
                    aria-label={`Отдел ${section.reviewGroup}`}
                    className="flex flex-col gap-2"
                  >
                    <h2 className="text-[15px] font-bold">
                      {section.reviewGroup === "RU"
                        ? "Проверка документов РУ"
                        : "Проверка документов ИГ"}
                    </h2>
                    {metrics(section.kpis, section.reviewGroup)}
                  </section>
                ))}
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <span className="text-[15px] font-bold">
                      Документы за текущую неделю · UTC
                    </span>
                  </CardHeader>
                  <CardContent>
                    <div
                      className="flex h-[150px] items-end gap-3"
                      role="img"
                      aria-label={data.weekly
                        .map((day) => `${day.day}: ${day.value}`)
                        .join(", ")}
                    >
                      {data.weekly.map((day) => (
                        <div
                          key={day.day}
                          className="flex min-w-0 flex-1 flex-col items-center gap-2"
                        >
                          <span className="text-xs font-semibold">
                            {day.value}
                          </span>
                          <div
                            className="w-full rounded-t bg-[var(--primary)]"
                            style={{
                              height: `${Math.max(2, (day.value / Math.max(1, ...data.weekly.map((row) => row.value))) * 110)}px`,
                            }}
                          />
                          <span className="text-xs text-[var(--muted-foreground)]">
                            {day.day}
                          </span>
                        </div>
                      ))}
                    </div>
                    {!data.weekly.some((day) => day.value) && (
                      <p className="mt-3 text-sm text-[var(--muted-foreground)]">
                        На этой неделе документы ещё не поступали.
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <span className="text-[15px] font-bold">
                      Текущие статусы документов
                    </span>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-5">
                    <Donut
                      slices={data.stages.map((slice, index) => ({
                        value: slice.value,
                        color: COLORS[index % COLORS.length],
                      }))}
                    />
                    <ul className="min-w-0 flex-1 space-y-2">
                      {data.stages.map((slice, index) => (
                        <li
                          key={slice.label}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{
                              background: COLORS[index % COLORS.length],
                            }}
                          />
                          <span className="min-w-0 flex-1">{slice.label}</span>
                          <span className="font-semibold tabular-nums">
                            {slice.value}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <span className="text-[15px] font-bold">
                      Требуют внимания
                    </span>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {!data.attention.length && (
                      <p className="text-sm text-[var(--muted-foreground)]">
                        Документов, требующих внимания, нет.
                      </p>
                    )}
                    {data.attention.map((item) => (
                      <div
                        key={item.documentId}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {item.fullName ?? "Кандидат без имени"}
                          </p>
                          <p className="break-words text-[var(--muted-foreground)]">
                            {item.title} ·{" "}
                            {item.status === "RETURNED"
                              ? "Возвращён"
                              : item.status === "OCR_FAILED"
                                ? "Ошибка распознавания"
                                : "На проверке"}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void navigate({
                              to:
                                item.reviewGroup === "IG"
                                  ? "/review-ig/$documentId"
                                  : "/review/$documentId",
                              params: { documentId: item.documentId },
                            })
                          }
                        >
                          Открыть
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <span className="text-[15px] font-bold">
                      Моя активность
                    </span>
                  </CardHeader>
                  <div>
                    {!data.activity.length && (
                      <p className="px-5 pb-4 text-sm text-[var(--muted-foreground)]">
                        Действий по выбранным документам пока нет.
                      </p>
                    )}
                    {data.activity.map((item, index) => (
                      <ActivityItem
                        key={`${item.time}-${index}`}
                        {...item}
                        time={formatDateTimeRu(item.time)}
                      />
                    ))}
                  </div>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
