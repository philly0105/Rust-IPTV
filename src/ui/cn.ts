import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the C10 theme: `shadow-1` to `shadow-3` are box-shadow
 * sizes (not colors), so `cn('shadow-1', 'shadow-2')` keeps only the last;
 * the type scale (`text-caption` ... `text-display`) is font sizes, so
 * `cn('text-body', 'text-fg')` keeps both (an unknown `text-*` would count as a
 * colour and drop the size); `ease-enter` / `ease-exit` are timing functions,
 * and the globals.css keyframes are known `animate-*` values.
 * Colors (`bg-surface-2`, `text-fg-muted`, `border-edge`), radii, and fonts
 * already resolve through tailwind-merge's open value matching.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['1', '2', '3'],
      text: ['caption', 'body-sm', 'body', 'title-sm', 'title', 'headline', 'display'],
      ease: ['enter', 'exit'],
      animate: [
        'shimmer',
        'toast-in',
        'toast-out',
        'fade-in',
        'fade-out',
        'pop-in',
        'pop-out',
        'drawer-in',
        'drawer-out',
        'sheet-in',
        'sheet-out',
        'live-pulse',
        'indeterminate',
      ],
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
