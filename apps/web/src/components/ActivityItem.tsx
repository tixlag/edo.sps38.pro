import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, FileCheck2, RefreshCw, Database } from 'lucide-react';

const iconByKind: Record<string, typeof FileCheck2> = {
  reminder: AlertTriangle,
  return: RefreshCw,
  check: FileCheck2,
  erp: Database,
  default: CheckCircle2,
};

// Known in-app targets for activity entries. Optional: current dashboard
// activity carries no URLs, so linkTo defaults to plain (non-clickable) rows.
// Deep links (/review/$documentId, /employees/$employeeId) are passed as
// strings and cast for TanStack Router (see HistoryPage auditLogLink).
export function ActivityItem({ kind, title, time, linkTo }: { kind: string; title: string; time: string; linkTo?: string }) {
  const Icon = iconByKind[kind] ?? iconByKind.default;
  const body = (
    <>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--info-soft)]">
        <Icon size={16} color="var(--info)" />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-snug">{title}</span>
        <span className="text-[11px] text-[var(--muted-foreground)]">{time}</span>
      </span>
    </>
  );
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-3 last:border-0">
      {linkTo ? (
        <Link to={linkTo as never} className="flex items-start gap-3 hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}
