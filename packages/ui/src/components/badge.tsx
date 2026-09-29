import * as React from 'react';
import { cn } from '../lib/cn';

const tones: Record<string, string> = {
  default: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
  info: 'bg-[var(--info-soft)] text-[var(--info)]',
  success: 'bg-[var(--success-soft)] text-[var(--success)]',
  warning: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  danger: 'bg-[var(--primary-soft)] text-[var(--primary)]',
  purple: 'bg-[var(--purple-soft)] text-[var(--purple)]',
};

export function Badge({
  tone = 'default',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
