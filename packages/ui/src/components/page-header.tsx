import * as React from 'react';
import { cn } from '../lib/cn';

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      <div className="flex flex-col gap-[5px]">
        <h1 className="text-[22px] font-bold tracking-tight text-[var(--foreground)]">{title}</h1>
        {subtitle && <p className="text-sm text-[var(--muted-foreground)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2.5">{actions}</div>}
    </div>
  );
}
