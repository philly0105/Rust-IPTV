import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the C10 theme: `shadow-1` / `shadow-2` are box-shadow
 * sizes (not colors), so `cn('shadow-1', 'shadow-2')` keeps only the last,
 * and the globals.css keyframes are known `animate-*` values.
 * Colors (`bg-surface-2`, `text-fg-muted`), radii, and fonts already resolve
 * through tailwind-merge's open value matching.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['1', '2'],
      animate: ['shimmer', 'toast-in', 'fade-in', 'pop-in', 'live-pulse', 'indeterminate'],
    },
  },
});

/**
 * Joins class names (falsy values dropped) and resolves Tailwind conflicts so
 * later classes win: `cn('px-3 bg-surface', className)` lets a caller's
 * `px-6` or `bg-accent` replace the primitive default instead of fighting it
 * in CSS source order.
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
