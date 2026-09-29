import { useGetEmployee } from '@edo/api-client';
import { Card, CardContent } from '@edo/ui';
import { PageHeader } from '@edo/ui';
import { StatusBadge } from '@edo/ui';

export function EmployeeDetailPage({ id }: { id: string }) {
  const { data, isLoading, isError } = useGetEmployee(id);
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader title={data?.fullName ?? 'Карточка работника'} subtitle={`ID: ${id}`} />
      <Card>
        <CardContent>
          {isLoading && <div className="py-8 text-center text-sm">Загрузка…</div>}
          {isError && <div className="py-8 text-center text-sm">Не удалось загрузить.</div>}
          {data && (
            <div className="flex flex-col gap-2 text-sm">
              <div><b>ФИО:</b> {data.fullName}</div>
              <div><b>Страна:</b> {data.country ?? '—'}</div>
              <div><b>Должность:</b> {data.position ?? '—'}</div>
              <div><b>Этап:</b> {data.stage ?? '—'}</div>
              <div className="flex items-center gap-2"><b>Статус:</b> <StatusBadge status={data.status} /></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
