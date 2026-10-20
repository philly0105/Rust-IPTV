/**
 * The Live sidebar's "Lists" group: every list with its channel count,
 * linking to /lists/:id, plus New list and Manage lists. Arrow keys, Home
 * and End move between the links (one tab stop). In Live it can fold away;
 * on the list page (`variant="page"`) it fills the column.
 */

import { ChevronDown, ListPlus, ListVideo, Settings2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, IconButton, Skeleton, cn, useRowHeight } from '@/ui';
import { intlLocale } from '@/lib/intl';
import { useLists } from '../hooks/useLists';
import { listPath } from '../paths';
import { openCreateList, openManageLists } from '../store';

export interface ListsSidebarSectionProps {
  activeListId?: string;
  /** Called after a link is followed (closes the Live drawer on narrow screens). */
  onNavigate?(): void;
  /** `section` (default) sits above Live's groups and can fold; `page` fills the list page's column. */
  variant?: 'section' | 'page';
}

const FOLD_KEY = 'lists.sidebarFolded';
const ROW = 36;
const ROW_SPACING = 17;

const linkClass = (active: boolean) =>
  `flex h-full items-center gap-2 rounded-md px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
    active ? 'tuning-tick bg-selected font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
  }`;
const countClass = (active: boolean) => `text-xs tabular-nums ${active ? 'text-fg-muted' : 'text-fg-subtle'}`;

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === '1';
  } catch {
    return false;
  }
}

export function ListsSidebarSection({ activeListId, onNavigate, variant = 'section' }: ListsSidebarSectionProps) {
  const { t, i18n } = useTranslation('lists');
  const { t: tc } = useTranslation('common');
  const lists = useLists();
  const rowHeight = useRowHeight(ROW, ROW_SPACING);
  const fmt = useMemo(() => new Intl.NumberFormat(intlLocale(i18n.language)), [i18n.language]);
  const headingId = useId();
  const bodyId = useId();
  const isPage = variant === 'page';
  const [folded, setFolded] = useState(() => !isPage && readFolded());
  const listRef = useRef<HTMLUListElement>(null);
  const items = lists.data ?? [];
  const activeIndex = items.findIndex((l) => l.id === activeListId);
  const [cursor, setCursor] = useState(Math.max(0, activeIndex));
  const tabStop = Math.min(Math.max(0, cursor), Math.max(0, items.length - 1));

  // Keep the tab stop on the open list when it changes from outside (navigation, reorder).
  useEffect(() => {
    if (activeIndex >= 0) setCursor(activeIndex);
  }, [activeIndex]);

  const toggleFold = () =>
    setFolded((f) => {
      try {
        localStorage.setItem(FOLD_KEY, f ? '0' : '1');
      } catch {
        // storage unavailable
      }
      return !f;
    });

  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(items.length - 1, i));
    setCursor(next);
    listRef.current?.querySelector<HTMLElement>(`[data-list-index="${next}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const at = Number((e.target as HTMLElement).dataset.listIndex);
    if (!Number.isFinite(at)) return;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(at + 1);
        break;
      case 'ArrowUp':
        moveTo(at - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(items.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  let body;
  if (lists.error) {
    body = (
      <div className="flex flex-col items-start gap-2 px-4 py-2 text-sm text-fg-muted" role="alert">
        <p>{t('loadFailed')}</p>
        <Button size="sm" variant="secondary" onClick={() => void lists.refetch()}>
          {tc('retry')}
        </Button>
      </div>
    );
  } else if (!lists.data) {
    body = (
      <div className="flex flex-col px-2" aria-busy="true" aria-label={t('loading')} role="status">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center px-2.5" style={{ height: rowHeight }}>
            <Skeleton className="h-3.5 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="mx-3 mb-1 flex flex-col items-start gap-2 rounded-md border border-dashed border-edge px-3 py-3 text-sm">
        <p className="text-fg-muted">{t('sidebarEmpty')}</p>
        <Button size="sm" variant="secondary" icon={<ListPlus className="size-4" />} onClick={() => openCreateList({ openAfter: true })}>
          {t('newList')}
        </Button>
      </div>
    );
  } else {
    body = (
      <ul
        ref={listRef}
        aria-labelledby={headingId}
        onKeyDown={onKeyDown}
        className={cn('flex flex-col px-2', isPage ? 'min-h-0 flex-1 overflow-y-auto pb-3' : 'max-h-[min(36vh,300px)] overflow-y-auto overscroll-contain pb-1')}
        data-testid="lists-sidebar"
      >
        {items.map((l, i) => {
          const active = l.id === activeListId;
          return (
            <li key={l.id} style={{ height: rowHeight }}>
              <Link
                to={listPath(l.id)}
                onClick={onNavigate}
                onFocus={() => setCursor(i)}
                data-list-index={i}
                tabIndex={i === tabStop ? 0 : -1}
                aria-current={active ? 'page' : undefined}
                title={l.name}
                className={linkClass(active)}
              >
                <ListVideo className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-fg-subtle')} aria-hidden />
                <span dir="auto" className="flex-1 truncate text-match-parent">
                  {l.name}
                </span>
                <span className={countClass(active)}>{fmt.format(l.itemCount)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} className={cn('flex flex-col', isPage ? 'h-full min-h-0' : 'border-b border-divider pb-1')} data-testid="lists-section">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        {isPage ? (
          <h2 id={headingId} className="flex-1 text-sm font-semibold text-fg">
            {t('title')}
          </h2>
        ) : (
          <h2 id={headingId} className="flex-1 text-sm font-semibold text-fg">
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={bodyId}
              onClick={toggleFold}
              className="-ms-1 flex items-center gap-1 rounded-md px-1 py-0.5 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChevronDown className={cn('size-3.5 text-fg-subtle motion-safe:transition-transform', folded && '-rotate-90 rtl:rotate-90')} aria-hidden />
              {t('title')}
              {folded && lists.data ? <span className="ms-1 text-xs font-normal tabular-nums text-fg-subtle">{fmt.format(items.length)}</span> : null}
            </button>
          </h2>
        )}
        <IconButton size="sm" label={t('newList')} icon={<ListPlus className="size-4" />} onClick={() => openCreateList({ openAfter: isPage })} />
        <IconButton size="sm" label={t('manageLists')} icon={<Settings2 className="size-4" />} onClick={() => openManageLists(activeListId)} />
      </div>
      <div id={bodyId} hidden={folded} className={cn(isPage && 'flex min-h-0 flex-1 flex-col')}>
        {body}
      </div>
    </section>
  );
}
