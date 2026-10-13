import * as React from 'react';
import { Card } from './card';
import { cn } from '../lib/cn';

export function MetricCard({
  label,
  value,
  hint,
  icon,
  accent,
  selected,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
  accent?: string;
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <Card
      onClick={onClick}
      className={cn(
        'flex h-[142px] flex-col justify-between p-4 text-left',
        onClick && 'cursor-pointer transition-shadow hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)]',
        selected && 'border-2 border-[var(--accent)]',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-[var(--muted-foreground)]">{label}</span>
        {icon && (
          <span
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px]"
            style={{ background: accent ?? 'var(--info-soft)' }}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="font-[Geist_Mono,monospace] text-[28px] font-bold leading-none text-[var(--foreground)]">
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--info)]">{hint}</div>}
    </Card>
  );
}
