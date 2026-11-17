import { Lock } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Category } from '@/api/types';
import { ChannelName } from '@/features/live/components/ChannelLogo';
import { intlLocale } from '@/lib/intl';
import { Dialog, SearchInput, cn, useListVirtualizer } from '@/ui';

import { handleGridKeyDown } from '../lib/gridNav';
import { sectionlessCategoryName } from '../lib/categoryName';
import { ALL_CATEGORIES, type VodKind } from '../lib/paging';

const ROW_H = 44;

export interface CategoryPickerDialogProps {
  open: boolean;
  onClose: () => void;
  kind: VodKind;
  /** The source's categories, hidden ones included (they are left out here). */
  categories: Category[] | undefined;
  currentId: string;
  hrefFor: (id: string) => string;
  /** History state the picked grid keeps (whether it was opened from the landing). */
  state: unknown;
  locked: (id: string) => boolean;
}

/**
 * Another category, picked from a category grid: the landing's index in a dialog (a sheet on a
 * phone), with a filter, the current category marked. The pick replaces the grid in history, so
 * Back still returns to the landing.
 */
export function CategoryPickerDialog({ open, onClose, kind, categories, currentId, hrefFor, state, locked }: CategoryPickerDialogProps) {
  const { t, i18n } = useTranslation('vod');
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const shown = useMemo(() => (categories ?? []).filter((c) => !c.hidden), [categories]);
  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = shown
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .map((c) => ({ id: c.id, name: c.name, label: sectionlessCategoryName(c.name, kind), count: c.itemCount }));
    if (q) return list;
    // All titles, counted as the grid's header and the landing's index count them (v-vod-11).
    const all = shown.reduce((n, c) => n + Math.max(0, c.itemCount), 0);
    return [{ id: ALL_CATEGORIES, name: '', label: kind === 'movie' ? t('allMovies') : t('allSeries'), count: all }, ...list];
  }, [shown, filter, kind, t]);
  // Sized to the whole list up to the cap, not to what the filter leaves, so the field holds still
  // while typing (the phone sheet is anchored at the bottom).
  const listHeight = Math.min((shown.length + 1) * ROW_H, 480);
  // On touch the filter would raise the keyboard over the list the user came to tap (v-vod-06):
  // focus goes to the list there, and the filter is one tap away.
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const v = useListVirtualizer({ count: entries.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 8 });
  const close = () => {
    setFilter('');
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} size="md" title={t('categories')}>
      <div className="flex flex-col gap-3">
        <SearchInput value={filter} onChange={setFilter} placeholder={t('filterCategories')} size="sm" data-autofocus={coarse ? undefined : ''} />
        <div
          ref={scrollRef}
          role="list"
          aria-label={t('categories')}
          tabIndex={coarse ? -1 : undefined}
          data-autofocus={coarse ? '' : undefined}
          className="max-h-[55vh] overflow-y-auto outline-none"
          style={{ height: listHeight }}
          onKeyDown={(e) => handleGridKeyDown(e, { count: entries.length })}
        >
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((row) => {
              const c = entries[row.index];
              if (!c) return null;
              const current = c.id === currentId;
              const isLocked = c.id !== ALL_CATEGORIES && locked(c.id);
              return (
                <div key={c.id} role="listitem" className="absolute start-0 w-full" style={{ top: row.start, height: ROW_H }}>
                  <Link
                    to={hrefFor(c.id)}
                    replace
                    state={state}
                    onClick={close}
                    data-grid-index={row.index}
                    aria-current={current ? 'page' : undefined}
                    title={c.name || undefined}
                    className={cn(
                      'flex h-11 items-center gap-3 rounded-md px-3 text-sm',
                      current ? 'tuning-tick bg-selected font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg',
                    )}
                  >
                    {/* "EN | ACTION" as group names read: the name, its language's tag after it, quiet. */}
                    <ChannelName name={c.label} className="min-w-0 flex-1 truncate text-match-parent" />
                    {isLocked && <Lock className="size-3.5 shrink-0 text-fg-subtle" role="img" aria-label={t('locked')} />}
                    {c.count > 0 && <span className="tabular text-caption text-fg-subtle">{fmt.format(c.count)}</span>}
                  </Link>
                </div>
              );
            })}
          </div>
          {entries.length === 0 && <p className="p-6 text-center text-sm text-fg-muted">{t('noCategoryMatch')}</p>}
        </div>
      </div>
    </Dialog>
  );
}
