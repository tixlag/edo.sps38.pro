import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-semibold transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 h-10 px-4',
        secondary: 'bg-[var(--muted)] text-[var(--foreground)] hover:opacity-80 h-10 px-4',
        outline: 'border border-[var(--border)] bg-[var(--card)] hover:bg-[var(--muted)] h-10 px-4',
        ghost: 'hover:bg-[var(--muted)] h-10 px-3',
      },
      size: {
        default: 'h-10',
        sm: 'h-8 px-3 text-[13px]',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
