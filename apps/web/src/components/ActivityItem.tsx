import { AlertTriangle, CheckCircle2, FileCheck2, RefreshCw, Database } from 'lucide-react';

const iconByKind: Record<string, typeof FileCheck2> = {
  reminder: AlertTriangle,
  return: RefreshCw,
  check: FileCheck2,
  erp: Database,
  default: CheckCircle2,
};

export function ActivityItem({ kind, title, time }: { kind: string; title: string; time: string }) {
  const Icon = iconByKind[kind] ?? iconByKind.default;
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-3 last:border-0">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--info-soft)]">
        <Icon size={16} color="var(--info)" />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-snug">{title}</span>
        <span className="text-[11px] text-[var(--muted-foreground)]">{time}</span>
      </span>
    </div>
  );
}
