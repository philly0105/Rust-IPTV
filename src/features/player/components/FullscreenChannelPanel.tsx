import { useVirtualizer } from '@tanstack/react-virtual';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import type { Channel } from '@/api/types';

import { cn } from '../cn';
import { focusIsLost, safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { playChannel, usePlayerStore } from '../store';

const PAGE = 100;
const ROW = 52;
const OPEN_DWELL_MS = 160;
const CLOSE_GRACE_MS = 420;
/** Pages kept around the visible window; everything else is dropped. */
const KEEP_PAGES = 3;

interface PageCache {
  total: number | null;
  pages: Map<number, Channel[]>;
}

function useChannelPages(sourceId: string | undefined, categoryId: string | undefined, search: string, enabled: boolean) {
  const [cache, setCache] = useState<PageCache>({ total: null, pages: new Map() });
  const [error, setError] = useState<unknown>(null);
  const inflight = useRef(new Set<number>());
  const gen = useRef(0);

  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    setCache({ total: null, pages: new Map() });
    setError(null);
  }, [sourceId, categoryId, search]);

  const ensure = useCallback(
    (page: number) => {
      if (!enabled || !sourceId || inflight.current.has(page)) return;
      inflight.current.add(page);
      const g = gen.current;
      const args: Parameters<typeof rpc<'catalog.channels'>>[1] = {
        sourceId,
        query: { offset: page * PAGE, limit: PAGE, sort: 'number', dir: 'asc', ...(search ? { search } : {}) },
      };
      if (categoryId) args.categoryId = categoryId;
      rpc('catalog.channels', args)
        .then((res) => {
          if (g !== gen.current) return;
          setCache((c) => {
            const pages = new Map(c.pages);
            pages.set(page, res.items);
            // Evict far pages so the panel never holds the whole catalog.
            for (const k of pages.keys()) if (Math.abs(k - page) > KEEP_PAGES) pages.delete(k);
            return { total: res.total, pages };
          });
        })
        .catch((err: unknown) => {
          if (g === gen.current) setError(err);
        })
        .finally(() => inflight.current.delete(page));
    },
    [enabled, sourceId, categoryId, search],
  );

  return { cache, error, ensure };
}

/**
 * Slide-in channel list inside the fullscreen player. Opens with C, a dwell on the left
 * edge, or a tap there; closes on pointer leave (with grace), Escape, C, or a click on the video.
 */
export function FullscreenChannelPanel({ available }: { available: boolean }) {
  const { t } = useTranslation('player');
  const open = useMediaStore((s) => s.channelPanelOpen);
  const zap = usePlayerStore((s) => s.zapContext);
  const current = usePlayerStore((s) => s.source?.ref);
  const sourceId = zap?.sourceId ?? current?.sourceId;
  const categoryId = zap && zap.sourceId === sourceId ? zap.categoryId : undefined;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const { cache, error, ensure } = useChannelPages(sourceId, categoryId, debounced, available && open);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setOpen = useCallback((v: boolean) => useMediaStore.setState({ channelPanelOpen: v }), []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!available && open) setOpen(false);
  }, [available, open, setOpen]);

  useEffect(() => {
    if (open) {
      ensure(0);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, ensure]);

  // Closing makes the panel inert, which drops focus from its search field to <body>:
  // give it back to whatever had it before the panel opened.
  const panelRef = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const a = document.activeElement;
      returnTo.current = a instanceof HTMLElement && !panelRef.current?.contains(a) ? a : null;
      return;
    }
    const panel = panelRef.current;
    const back = returnTo.current;
    returnTo.current = null;
    if (!back?.isConnected) return;
    const a = document.activeElement;
    if (focusIsLost() || (panel && a && panel.contains(a))) back.focus({ preventScroll: true });
  }, [open]);

  useEffect(
    () => () => {
      if (dwell.current) clearTimeout(dwell.current);
      if (grace.current) clearTimeout(grace.current);
    },
    [],
  );

  const total = cache.total ?? 0;
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (!open || cache.total === null) return;
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) if (!cache.pages.has(p)) ensure(p);
  }, [open, first, last, cache, ensure]);

  const rowAt = useMemo(
    () =>
      (i: number): Channel | undefined =>
        cache.pages.get(Math.floor(i / PAGE))?.[i % PAGE],
    [cache],
  );

  if (!available) return null;

  const isCurrent = (c: Channel): boolean =>
    !!current && c.ref.itemId === current.itemId && c.ref.sourceId === current.sourceId;

  return (
    <>
      {/* Hot zone on the inline-start edge (left, or right in RTL), where the panel slides in from */}
      {!open && (
        <div
          aria-hidden
          className="absolute inset-y-0 start-0 z-30 w-3"
          onPointerEnter={() => {
            dwell.current = setTimeout(() => setOpen(true), OPEN_DWELL_MS);
          }}
          onPointerLeave={() => {
            if (dwell.current) clearTimeout(dwell.current);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        />
      )}
      {open && (
        <div
          aria-hidden
          className="absolute inset-0 z-30"
          onClick={(e) => {
            // A click on the video closes the panel without pausing.
            e.stopPropagation();
            setOpen(false);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
      <aside
        ref={panelRef}
        aria-label={t('channelPanel')}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          'absolute inset-y-0 start-0 z-40 flex w-[min(360px,85vw)] flex-col border-e border-white/10 bg-[rgb(9_13_21/0.92)] text-white shadow-2 backdrop-blur-md',
          'motion-safe:transition-transform motion-safe:duration-200',
          open ? 'translate-x-0' : '-translate-x-full rtl:translate-x-full',
        )}
        onPointerEnter={() => {
          if (grace.current) clearTimeout(grace.current);
        }}
        onPointerLeave={() => {
          grace.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Consumed only while open, so Escape still exits fullscreen when it is closed.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchChannels')}
            aria-label={t('searchChannels')}
            className="min-w-0 flex-1 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white placeholder:text-white/50"
          />
          <button
            type="button"
            aria-label={t('close')}
            onClick={() => setOpen(false)}
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-white/10"
          >
            <X className="size-4" />
          </button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label={t('channels')}>
          {error ? (
            <p className="p-4 text-sm text-white/70">{t('channelsFailed')}</p>
          ) : cache.total === 0 ? (
            <p className="p-4 text-sm text-white/70">{t('noChannels')}</p>
          ) : cache.total === null ? (
            <div className="space-y-2 p-3" aria-busy>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-10 rounded-md bg-white/8 motion-safe:animate-pulse" />
              ))}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map((v) => {
                const c = rowAt(v.index);
                return (
                  <div
                    key={v.key}
                    className="absolute inset-x-0 px-2"
                    style={{ top: v.start, height: ROW }}
                  >
                    {c ? (
                      <button
                        type="button"
                        role="option"
                        aria-selected={isCurrent(c)}
                        onClick={() => void playChannel(c).catch(() => undefined)}
                        className={cn(
                          'flex h-[48px] w-full items-center gap-3 rounded-md px-2 text-start hover:bg-white/10',
                          isCurrent(c) && 'bg-white/10 text-white dark:text-accent-hover',
                        )}
                      >
                        <span className="w-10 shrink-0 text-end font-display text-sm text-white/70 tabular-nums">
                          {c.number ?? ''}
                        </span>
                        {safeImageUrl(c.logoUrl) ? (
                          <img src={safeImageUrl(c.logoUrl)} alt="" loading="lazy" className="size-8 shrink-0 rounded-sm bg-white/5 object-contain" />
                        ) : (
                          <span className="size-8 shrink-0 rounded-sm bg-white/5" aria-hidden />
                        )}
                        <span dir="auto" className="truncate text-sm text-match-parent">{c.name}</span>
                      </button>
                    ) : (
                      <div className="mt-1 h-10 rounded-md bg-white/6" aria-hidden />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
