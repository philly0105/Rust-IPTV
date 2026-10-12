import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

export interface PaginationProps {
  offset: number;
  limit: number;
  total: number;
  /** Receives the new offset. */
  onChange: (offset: number) => void;
  className?: string;
}

/** Page numbers to show: first, last, current +- 1, with gaps as null. */
export function pageWindow(current: number, count: number): (number | null)[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const pages = new Set([0, count - 1, current - 1, current, current + 1]);
  if (current <= 2) [1, 2, 3].forEach((p) => pages.add(p));
  if (current >= count - 3) [count - 4, count - 3, count - 2].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 0 && p < count).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push(null);
    out.push(p);
  });
  return out;
}

export function Pagination({ offset, limit, total, onChange, className }: PaginationProps) {
  const { t } = useTranslation('common');
  if (limit <= 0 || total <= limit) return null;
  const count = Math.ceil(total / limit);
  const current = Math.min(count - 1, Math.floor(offset / limit));
  const go = (p: number) => onChange(Math.max(0, Math.min(count - 1, p)) * limit);
  const from = current * limit + 1;
  const to = Math.min(total, from + limit - 1);
  const btn =
    'inline-flex h-9 min-w-9 items-center justify-center rounded-md px-2 text-sm tabular text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 disabled:pointer-events-none disabled:opacity-40';

  return (
    <nav aria-label={t('pagination')} className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <p className="text-sm text-fg-muted tabular">{t('paginationRange', { from, to, total })}</p>
      <ul className="flex items-center gap-1">
        <li>
          <button type="button" className={btn} onClick={() => go(current - 1)} disabled={current === 0} aria-label={t('previousPage')}>
            <ChevronLeft aria-hidden size={16} className="rtl:rotate-180" />
          </button>
        </li>
        {pageWindow(current, count).map((p, i) =>
          p === null ? (
            <li key={`gap-${i}`} aria-hidden className="px-1 text-fg-subtle">
              …
            </li>
          ) : (
            <li key={p}>
              <button
                type="button"
                className={cn(btn, p === current && 'bg-surface-3 font-semibold text-fg')}
                aria-current={p === current ? 'page' : undefined}
                aria-label={t('pageN', { page: p + 1 })}
                onClick={() => go(p)}
              >
                {p + 1}
              </button>
            </li>
          ),
        )}
        <li>
          <button type="button" className={btn} onClick={() => go(current + 1)} disabled={current >= count - 1} aria-label={t('nextPage')}>
            <ChevronRight aria-hidden size={16} className="rtl:rotate-180" />
          </button>
        </li>
      </ul>
    </nav>
  );
}
