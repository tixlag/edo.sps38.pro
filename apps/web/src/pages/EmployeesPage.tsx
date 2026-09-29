import type { ColumnDef } from '@tanstack/react-table';
import { useListEmployees, type EmployeeDto } from '@edo/api-client/src/generated/api';
import { Card, CardContent } from '@edo/ui/src/components/card';
import { PageHeader } from '@edo/ui/src/components/page-header';
import { StatusBadge } from '@edo/ui/src/components/status-badge';
import { Button } from '@edo/ui/src/components/button';
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

export function EmployeesPage({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading, isError } = useListEmployees();

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader
        title="Работники"
        subtitle="Первый vertical slice: MariaDB → Prisma → NestJS → OpenAPI → Orval → React"
        actions={<Button>Добавить работника</Button>}
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
                    <Button size="sm" variant="outline" onClick={() => onOpen(row.original.id)}>
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
