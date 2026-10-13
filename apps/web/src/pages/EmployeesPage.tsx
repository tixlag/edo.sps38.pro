import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from '@tanstack/react-router';
import { useListEmployees, type EmployeeDto } from '@edo/api-client';
import { Card, CardContent } from '@edo/ui';
import { PageHeader } from '@edo/ui';
import { StatusBadge } from '@edo/ui';
import { Button } from '@edo/ui';
import { DataTable } from '../components/DataTable';

const columns: ColumnDef<EmployeeDto>[] = [
  { header: 'ФИО', accessorKey: 'fullName' },
  { header: 'Страна', accessorKey: 'country' },
  { header: 'Должность', accessorKey: 'position' },
  { header: 'Этап', accessorKey: 'stage' },
  {
    header: 'Статус',
    accessorKey: 'status',
    cell: ({ getValue }) => <StatusBadge status={String(getValue())} />,
  },
];

export function EmployeesPage() {
  const { data, isLoading, isError } = useListEmployees();
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader
        title="Работники"
        subtitle="Дела оформления сотрудников в пределах ваших прав доступа"
        actions={<Button disabled title="Создание дела пока недоступно">Добавить работника</Button>}
      />
      <Card>
        <CardContent>
          {isLoading && <div className="py-8 text-center text-sm">Загрузка…</div>}
          {isError && <div className="py-8 text-center text-sm">Не удалось загрузить список.</div>}
          {data && (
            <DataTable<EmployeeDto>
              columns={[
                ...columns,
                {
                  id: 'actions',
                  header: '',
                  cell: ({ row }) => (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void navigate({ to: `/employees/${row.original.id}` })}
                    >
                      Открыть
                    </Button>
                  ),
                },
              ]}
              data={data.items}
              emptyTitle="Нет работников"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
