import { useGetDashboard } from '@edo/api-client/src/generated/api';
import { Card, CardContent, CardHeader } from '@edo/ui/src/components/card';
import { MetricCard } from '@edo/ui/src/components/metric-card';
import { PageHeader } from '@edo/ui/src/components/page-header';
import { Button } from '@edo/ui/src/components/button';
import { ActivityItem } from '../components/ActivityItem';
import { CheckCircle2, FileCheck2, AlertTriangle, PenLine, Award, RefreshCw } from 'lucide-react';

const KPI_ICONS = [FileCheck2, AlertTriangle, PenLine, Award, RefreshCw, CheckCircle2];
const KPI_ACCENTS = [
  'var(--info-soft)',
  'var(--warning-soft)',
  'var(--primary-soft)',
  'var(--success-soft)',
  'var(--warning-soft)',
  'var(--purple-soft)',
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
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  let acc = 0;
  const stops = slices
    .map((s) => {
      const from = (acc / total) * 360;
      acc += s.value;
      const to = (acc / total) * 360;
      return `${s.color} ${from}deg ${to}deg`;
    })
    .join(', ');
  return (
    <div
      className="relative h-[120px] w-[120px] shrink-0 rounded-full"
      style={{ background: `conic-gradient(${stops})` }}
    >
      <div className="absolute inset-[22px] flex items-center justify-center rounded-full bg-white">
        <span className="font-mono text-[20px] font-bold">{total}</span>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data, isLoading, isError } = useGetDashboard();

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader
        title="Дашборд"
        subtitle="Оформление сотрудников · данные backend через generated hooks"
        actions={
          <>
            <Button variant="outline">Фильтры</Button>
            <Button>Добавить работника</Button>
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
          <div className="grid h-[142px] grid-cols-6 gap-[14px]">
            {data.kpis.map((kpi, i) => {
              const Icon = KPI_ICONS[i % KPI_ICONS.length];
              return (
                <MetricCard
                  key={kpi.key}
                  label={kpi.label}
                  value={kpi.value}
                  hint={kpi.hint}
                  accent={KPI_ACCENTS[i % KPI_ACCENTS.length]}
                  icon={<Icon size={18} />}
                />
              );
            })}
          </div>

          <div className="flex h-[300px] gap-5">
            <Card className="flex w-[1100px] max-w-[60%] flex-col">
              <CardHeader>
                <div className="flex flex-col">
                  <span className="text-[15px] font-bold">Оформлено за неделю</span>
                  <span className="text-[12px] text-[var(--muted-foreground)]">Пн — Вс · источник: backend seed</span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 items-end gap-3">
                {data.weekly.map((b) => (
                  <div key={b.day} className="flex flex-1 flex-col items-center gap-2">
                    <div
                      className="w-full rounded-t-[6px] bg-[var(--primary)]"
                      style={{ height: `${Math.max(8, b.value * 22)}px`, opacity: 0.85 }}
                    />
                    <span className="text-[11px] text-[var(--muted-foreground)]">{b.day}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="flex flex-1 flex-col">
              <CardHeader>
                <span className="text-[15px] font-bold">Работники по этапам</span>
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
                  <ActivityItem key={i} kind={a.kind} title={a.title} time={a.time} />
                ))}
              </div>
            </Card>

            <div className="flex flex-1 flex-col gap-4">
              <Card>
                <CardHeader>
                  <span className="text-[15px] font-bold">Заблокированы на шаге</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {data.blocked.map((b) => (
                    <div key={b.fullName} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="flex flex-col">
                        <span className="font-semibold">{b.fullName}</span>
                        <span className="text-[var(--muted-foreground)]">{b.step}</span>
                      </span>
                      <Button size="sm" variant="outline">Открыть</Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <span className="text-[15px] font-bold">Мои задачи на сегодня</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {data.tasks.map((t) => (
                    <div key={t.title} className="flex items-center justify-between gap-2 text-[13px]">
                      <span>{t.title}</span>
                      <Button size="sm">Готово</Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
