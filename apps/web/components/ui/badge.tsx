import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Badge（M13-F1）：状态徽标。variant 语义固定，页面按后端状态字面量映射（不做业务判定）。
 * 与既有 button 一致使用 cva，便于后续扩展且保持源码风格。
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-zinc-800 text-zinc-300',
        secondary: 'bg-zinc-800/60 text-zinc-400',
        outline: 'border border-zinc-700 text-zinc-300',
        success: 'bg-emerald-900/60 text-emerald-300',
        warning: 'bg-amber-900/60 text-amber-300',
        destructive: 'bg-red-900/60 text-red-300',
        info: 'bg-sky-900/60 text-sky-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(({ className, variant, ...props }, ref) => (
  <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
));
Badge.displayName = 'Badge';

export { Badge, badgeVariants };
