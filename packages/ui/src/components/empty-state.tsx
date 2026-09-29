import * as React from 'react';
import { cn } from '../lib/cn';

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12 text-center', className)}>
      <div className="text-sm font-semibold text-[var(--foreground)]">{title}</div>
      {description && <div className="max-w-sm text-[13px] text-[var(--muted-foreground)]">{description}</div>}
      {action}
    </div>
  );
}
