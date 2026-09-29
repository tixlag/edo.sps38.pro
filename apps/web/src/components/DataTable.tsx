import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { EmptyState } from '@edo/ui/src/components/empty-state';

export function DataTable<T>({
  columns,
  data,
  emptyTitle = 'Нет данных',
  emptyDescription,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const table = useReactTable({ columns, data, getCoreRowModel: getCoreRowModel() });
  if (data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-[var(--border)]">
              {hg.headers.map((h) => (
                <th key={h.id} className="px-4 py-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/60">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
