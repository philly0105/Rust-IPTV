import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Link } from 'react-router';

import type { Category } from '@/api/types';

import { columnsFor, useElementWidth, useScrollMargin } from '../hooks/useContainerColumns';
import { handleGridKeyDown } from '../lib/gridNav';
import { cn } from '@/ui';

export interface CategoryEntry {
  id: string;
  name: string;
  /** Omitted when the source does not report counts (Stalker). */
  count?: number;
  emphasis?: boolean;
  /** Parental Ask mode: the category asks for the PIN (the lock Live's groups carry). */
  locked?: boolean;
}

export interface CategoryIndexProps {
  entries: CategoryEntry[];
  hrefFor: (id: string) => string;
  /** The page's scroll container, used for row virtualization. */
  scrollRef: RefObject<HTMLElement | null>;
  label: string;
  /** Name of the lock mark ("Locked"). */
  lockedLabel?: string;
}

const MIN_COL = 260;
const GAP = 8;
const ROW_H = 48;
/** Location state on the landing's category links (the grid's Escape steps back through history). */
const FROM_LANDING = { fromLanding: true } as const;

/**
 * The category index: a dial-like list of category names with their item
 * counts set in tabular display figures, flowing into as many columns as the
 * width allows. Rows are virtualized against the page scroller, so portals
 * with thousands of categories stay cheap.
 */
export function CategoryIndex({ entries, hrefFor, scrollRef, label, lockedLabel }: CategoryIndexProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(listRef);
  const columns = columnsFor(width || MIN_COL, MIN_COL, GAP);
  const rows = Math.ceil(entries.length / columns);
  const margin = useScrollMargin(listRef, scrollRef, [entries.length > 0]);
  const { i18n } = useTranslation();
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);

  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 6,
    scrollMargin: margin,
  });

  return (
    <div
      ref={listRef}
      role="list"
      aria-label={label}
      onKeyDown={(e) => handleGridKeyDown(e, { count: entries.length })}
      style={{ height: v.getTotalSize(), position: 'relative' }}
    >
      {v.getVirtualItems().map((row) => (
        <div
          key={row.key}
          className="absolute start-0 grid w-full"
          style={{
            top: row.start - margin,
            height: ROW_H,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            columnGap: GAP,
          }}
        >
          {Array.from({ length: columns }, (_, c) => {
            const i = row.index * columns + c;
            const entry = entries[i];
            if (!entry) return null;
            return (
              <div key={entry.id} role="listitem" className="min-w-0">
                <Link
                  to={hrefFor(entry.id)}
                  // The grid reads this: Escape there goes back one step instead of pushing the landing again.
                  state={FROM_LANDING}
                  data-grid-index={i}
                  title={entry.locked && lockedLabel ? `${entry.name} (${lockedLabel})` : undefined}
                  className={cn(
                    'group flex h-11 items-center gap-3 rounded-md border-b border-divider px-3',
                    'text-sm text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg',
                    entry.emphasis && 'font-semibold text-fg',
                  )}
                >
                  <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent">{entry.name}</span>
                  {entry.locked && (
                    <Lock data-testid="category-locked" className="size-3.5 shrink-0 text-fg-subtle" role="img" aria-label={lockedLabel} />
                  )}
                  {entry.count !== undefined && entry.count > 0 && (
                    <span className="tabular font-display text-[calc(13rem/15)] text-fg-subtle group-hover:text-accent group-focus-visible:text-accent">
                      {fmt.format(entry.count)}
                    </span>
                  )}
                </Link>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function categoryEntries(categories: Category[], filter: string): CategoryEntry[] {
  const q = filter.trim().toLowerCase();
  return categories
    .filter((c) => !c.hidden && (!q || c.name.toLowerCase().includes(q)))
    .map((c) => ({ id: c.id, name: c.name, count: c.itemCount }));
}
