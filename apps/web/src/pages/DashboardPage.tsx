import { useGetDashboard, useGetMe } from '@edo/api-client';
import { Card, CardContent, CardHeader } from '@edo/ui';
import { MetricCard } from '@edo/ui';
import { PageHeader } from '@edo/ui';
import { Button } from '@edo/ui';
import { ActivityItem } from '../components/ActivityItem';
import { CheckCircle2, FileCheck2, AlertTriangle, Clock, PenLine, Award, RefreshCw } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';

type KpiGroup = 'review' | 'signing' | 'general';

// Key-based card meta (never index-based: backend KPI order must not swap icons).
// Groups mirror the backend KpiDto.group values ('review' | 'signing' | 'general').
// Exported for unit tests asserting KPI -> list transitions.
// Transition rules: every `to` target must show the SAME scoped set the KPI
// counts. `queue` counts IN_REVIEW documents -> /review queue (same
// documentWhere scope). `rework` counts RETURNED documents in the same scope
// -> /review with the RETURNED tab (queue filter `status=RETURNED`; the tab
// itself lands with agent B). Never link to /history: for a plain 20002
// reviewer it shows only own actions (mine=true), while the KPI counts every
// in-scope document. `in_review` counts employee cases, not documents, and
// /employees has no status filter -> not clickable (never link a case KPI to
// the document queue).
export const KPI_META: Record<string, { icon: typeof FileCheck2; accent: string; group: KpiGroup; to?: '/review' | '/employees' | '/history' }> = {
  queue: { icon: FileCheck2, accent: 'var(--info-soft)', group: 'review', to: '/review' },
  in_review: { icon: Clock, accent: 'var(--info-soft)', group: 'review' },
  rework: { icon: CheckCircle2, accent: 'var(--purple-soft)', group: 'review', to: '/review' },
  expired: { icon: RefreshCw, accent: 'var(--warning-soft)', group: 'review' },
  signing: { icon: PenLine, accent: 'var(--primary-soft)', group: 'signing' },
  hired: { icon: Award, accent: 'var(--success-soft)', group: 'signing' },
  stuck: { icon: AlertTriangle, accent: 'var(--warning-soft)', group: 'general', to: '/employees' },
};

const FALLBACK_META = { icon: CheckCircle2, accent: 'var(--info-soft)', group: 'general' as KpiGroup };

const KPI_GROUPS: Array<{ key: KpiGroup; title: string }> = [
  { key: 'review', title: 'Проверка документов' },
  { key: 'signing', title: 'Подписание' },
  { key: 'general', title: 'Общее' },
];

const STAGE_COLORS = [
  'var(--info)',
  'var(--success)',
  'var(--warning)',
  'var(--purple)',
  'var(--primary)',
  'var(--muted-foreground)',
];

function Donut({ slices }: { slices: { value: number; color: string }[] }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  let acc = 0;
  const stops = slices
    .map((s) => {
      const from = (acc / (total || 1)) * 360;
      acc += s.value;
      const to = (acc / (total || 1)) * 360;
      return `${s.color} ${from}deg ${to}deg`;
    })
    .join(', ');
  return (
    <div
      className="relative h-[120px] w-[120px] shrink-0 rounded-full"
      style={{ background: total ? `conic-gradient(${stops})` : 'var(--border)' }}
    >
      <div className="absolute inset-[22px] flex items-center justify-center rounded-full bg-white">
        <span className="font-mono text-[20px] font-bold">{total}</span>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data, isLoading, isError } = useGetDashboard();
  const { data: profile } = useGetMe();
  const navigate = useNavigate();

  // 20002 = DOCUMENT_REVIEW, 20003 = SIGNING, 20009 = FULL_ACCESS.
  // Key presence grants (never truthiness: `[]` means granted).
  const permissions = profile?.permissions;
  const hasRule = (...rules: string[]) =>
    !!permissions && rules.some((rule) => Object.prototype.hasOwnProperty.call(permissions, rule));
  const canReview = hasRule('20002', '20011', '20009');
  const canSign = hasRule('20003', '20009');

  const groupVisible = (group: KpiGroup) =>
    group === 'review' ? canReview : group === 'signing' ? canSign : true;
  const kpisOf = (group: KpiGroup) =>
    (data?.kpis ?? []).filter((kpi) => (KPI_META[kpi.key] ?? FALLBACK_META).group === group);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader
        title="Дашборд"
        subtitle="Дела оформления в пределах ваших прав доступа"
        actions={
          <>
            <Button variant="outline" disabled title="Фильтры пока недоступны">Фильтры</Button>
            <Button disabled title="Создание дела пока недоступно">Добавить работника</Button>
          </>
        }
      />

      {isLoading && <Card><CardContent>Загрузка дашборда…</CardContent></Card>}
      {isError && (
        <Card>
          <CardContent>Не удалось загрузить дашборд. Проверьте, что API доступно.</CardContent>
        </Card>
      )}

      {data && (
        <>
          {KPI_GROUPS.filter((group) => groupVisible(group.key) && kpisOf(group.key).length > 0).map((group) => (
            <section key={group.key} aria-label={group.title} className="flex flex-col gap-2">
              <h2 className="text-[15px] font-bold">{group.title}</h2>
              <div className="grid grid-cols-4 gap-[14px]">
                {kpisOf(group.key).map((kpi) => {
                  const meta = KPI_META[kpi.key] ?? FALLBACK_META;
                  const Icon = meta.icon;
                  // A combined RU+IG count has no single queue destination.
                  const combinedReview = hasRule("20002", "20009") && hasRule("20011", "20009");
                  const to = meta.to === "/review"
                    ? combinedReview ? undefined : hasRule("20002", "20009") ? "/review" : "/review-ig"
                    : meta.to;
                  return (
                    <MetricCard
                      key={kpi.key}
                      label={kpi.label}
                      value={kpi.value}
                      hint={kpi.hint}
                      accent={meta.accent}
                      icon={<Icon size={18} />}
                      onClick={to ? () => void navigate({ to }) : undefined}
                    />
                  );
                })}
              </div>
            </section>
          ))}

          <div className="flex h-[300px] gap-5">
            <Card className="flex w-[1100px] max-w-[60%] flex-col">
              <CardHeader>
                <div className="flex flex-col">
                  <span className="text-[15px] font-bold">Новые дела за неделю</span>
                  <span className="text-[12px] text-[var(--muted-foreground)]">Пн — Вс · текущая неделя, UTC</span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 items-end gap-3">
                {data.weekly.map((b) => (
                  <div key={b.day} className="flex flex-1 flex-col items-center gap-2">
                    <div
                      className="w-full rounded-t-[6px] bg-[var(--primary)]"
                      style={{ height: b.value ? `${Math.max(8, b.value / Math.max(1, ...data.weekly.map(item => item.value)) * 180)}px` : '0px', opacity: 0.85 }}
                    />
                    <span className="text-[11px] text-[var(--muted-foreground)]">{b.day}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="flex flex-1 flex-col">
              <CardHeader>
                <div className="flex flex-col">
                  <span className="text-[15px] font-bold" title="Статус дела в ЭДО; не связан с шагами адаптации в ЛК">Дела по статусам</span>
                  <span className="text-[12px] text-[var(--muted-foreground)]">Статусы дел в ЭДО</span>
                </div>
              </CardHeader>
              <CardContent className="flex items-center gap-4">
                <Donut slices={data.stages.map((s, i) => ({ value: s.value, color: STAGE_COLORS[i % STAGE_COLORS.length] }))} />
                <div className="flex flex-1 flex-col gap-2">
                  {data.stages.map((s, i) => (
                    <div key={s.label} className="flex items-center justify-between text-[13px]">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: STAGE_COLORS[i % STAGE_COLORS.length] }}
                        />
                        {s.label}
                      </span>
                      <span className="font-mono font-bold">{s.value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-1 gap-5">
            <Card className="flex w-[1100px] max-w-[60%] flex-col">
              <CardHeader>
                <span className="text-[15px] font-bold">Последние действия</span>
              </CardHeader>
              <div>
                {data.activity.map((a, i) => (
                  <ActivityItem key={i} kind={a.kind} title={a.title} time={new Date(a.time).toLocaleString('ru-RU')} />
                ))}
                {data.activity.length === 0 && <p className="px-5 py-6 text-sm text-[var(--muted-foreground)]">Ваших действий в EDO пока нет.</p>}
              </div>
            </Card>

            <div className="flex flex-1 flex-col gap-4">
              <Card>
                <CardHeader>
                  <span className="text-[15px] font-bold">Заблокированы на шаге</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {data.blocked.map((b) => (
                    <div key={b.employeeId} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="flex flex-col">
                        <span className="font-semibold">{b.fullName}</span>
                        <span className="text-[var(--muted-foreground)]">{b.step}</span>
                      </span>
                      <Button size="sm" variant="outline" onClick={() => void navigate({ to: `/employees/${b.employeeId}` })}>Открыть</Button>
                    </div>
                  ))}
                  {data.blocked.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">Заблокированных дел нет.</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <span className="text-[15px] font-bold">Мои открытые задачи</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {data.tasks.map((t) => (
                    <div key={t.title} className="flex items-center justify-between gap-2 text-[13px]">
                      <span>{t.title}</span>
                      <Button size="sm" disabled title="Завершение задачи пока недоступно">Готово</Button>
                    </div>
                  ))}
                  {data.tasks.length === 0 && <p className="text-sm text-[var(--muted-foreground)]">Вам пока не назначены задачи.</p>}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
