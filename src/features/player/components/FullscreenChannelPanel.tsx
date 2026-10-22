import { PanelLeftOpen, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import { itemKey, type Channel } from '@/api/types';
import { useImageChain } from '@/ui/image';
import { gateImage } from '@/ui/imageGate';
import { useListVirtualizer } from '@/ui/virtualizer';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { focusIsLost, pressKeepsFocus, safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { playChannel, usePlayerStore } from '../store';
import { useStreamInfoStore } from '../streamInfo';
import { fetchChannelInfo } from '../zapBanner';
import { PanelArchiveButton, PanelNowLines } from './ChannelPanelGuide';
import { locateChannel } from './channelPanelLocate';

/**
 * A row's channel logo through the image cache (C3), then its own URL once and the cache again,
 * then a blank tile.
 * Fetched through the shared image gate (ui/imageGate.ts), as ChannelLogo's: at most four at once,
 * the rows in view first, and a row that leaves before its turn asks nothing. `defer` (the list
 * is scrolling) is RowLogo's own latch on top of the gate: `allowed` holds the last address let
 * through, so a logo not showing yet waits for the scroll to rest before it reaches the gate, and
 * one already showing stays, since its <img> is kept while the address is the same.
 */
function RowLogo({ url, sourceId, defer = false }: { url?: string | null; sourceId: string; defer?: boolean }) {
  const image = useImageChain([safeImageUrl(url ?? undefined)], sourceId, 32);
  const src = image.url;
  // The address last allowed to load: a reused row that shows another channel while `defer` holds waits.
  const [allowed, setAllowed] = useState(defer ? undefined : src);
  if (!defer && allowed !== src) setAllowed(src);
  const waiting = defer && allowed !== src;
  // One <img> per address (keyed below): React renders no `src`, the gate sets it.
  const imgRef = useCallback((el: HTMLImageElement | null) => (el && src ? gateImage(el, src) : undefined), [src]);
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-white/5">
      {src && !waiting && (
        <img
          key={src}
          ref={imgRef}
          alt=""
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          draggable={false}
          onError={image.onError}
          // Waiting for the gate (no src yet) the box fills the tile, so a row half in view counts as in view.
          className="max-h-full max-w-full object-contain [&:not([src])]:size-full"
        />
      )}
    </span>
  );
}

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

function pageArgs(sourceId: string, categoryId: string | undefined, search: string, page: number): Parameters<typeof rpc<'catalog.channels'>>[1] {
  const args: Parameters<typeof rpc<'catalog.channels'>>[1] = {
    sourceId,
    query: { offset: page * PAGE, limit: PAGE, sort: 'number', dir: 'asc', ...(search ? { search } : {}) },
  };
  if (categoryId) args.categoryId = categoryId;
  return args;
}

/** Keeps `page` and drops pages far from it, so the panel never holds the whole catalog. */
function withPage(c: PageCache, page: number, items: Channel[], total: number): PageCache {
  const pages = new Map(c.pages);
  pages.set(page, items);
  for (const k of pages.keys()) if (Math.abs(k - page) > KEEP_PAGES) pages.delete(k);
  return { total, pages };
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
      rpc('catalog.channels', pageArgs(sourceId, categoryId, search, page))
        .then((res) => {
          if (g === gen.current) setCache((c) => withPage(c, page, res.items, res.total));
        })
        .catch((err: unknown) => {
          if (g === gen.current) setError(err);
        })
        .finally(() => inflight.current.delete(page));
    },
    [enabled, sourceId, categoryId, search],
  );

  /** A page fetched elsewhere (finding the playing channel) for the current list. */
  const seed = useCallback((page: number, items: Channel[], total: number) => setCache((c) => withPage(c, page, items, total)), []);

  return { cache, error, ensure, seed };
}

/**
 * The channels of the channel list being zapped (lists.items), in list order, in the same page
 * shape as the source pages. A list holds at most 2000 channels, so it is read whole and
 * searched here. `failed`: the list cannot be read (deleted meanwhile): use the source instead.
 */
function useListPages(listId: string | undefined, search: string, enabled: boolean): { cache: PageCache; failed: boolean } {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setChannels(null);
    setFailed(false);
    if (!enabled || !listId) return;
    let live = true;
    rpc('lists.items', { id: listId })
      .then((rows) => {
        // Channels the provider dropped cannot play: the panel leaves them out, as zapping does.
        if (live) setChannels(rows.flatMap((r) => (r.available && r.channel ? [r.channel] : [])));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [listId, enabled]);

  const cache = useMemo<PageCache>(() => {
    if (!channels) return { total: null, pages: new Map() };
    const q = search.toLocaleLowerCase();
    const rows = q ? channels.filter((c) => c.name.toLocaleLowerCase().includes(q)) : channels;
    const pages = new Map<number, Channel[]>();
    for (let p = 0; p * PAGE < rows.length; p++) pages.set(p, rows.slice(p * PAGE, (p + 1) * PAGE));
    return { total: rows.length, pages };
  }, [channels, search]);

  return { cache, failed };
}

/**
 * Slide-in channel list inside the fullscreen player. Opens with C, a dwell on the left
 * edge, a tap there, or the Channel list button that shows with the player's controls
 * (`chromeVisible`; touch screens have no edge to dwell on); closes on pointer leave (with
 * grace), Escape, C, or a click on the video.
 */
export function FullscreenChannelPanel({ available, chromeVisible = false }: { available: boolean; chromeVisible?: boolean }) {
  const { t } = useTranslation('player');
  const open = useMediaStore((s) => s.channelPanelOpen);
  // The stream info panel takes the same edge: the button gives it the room.
  const statsOpen = useStreamInfoStore((s) => s.open);
  const zap = usePlayerStore((s) => s.zapContext);
  const current = usePlayerStore((s) => s.source?.ref);
  const sourceId = zap?.sourceId ?? current?.sourceId;
  const categoryId = zap && zap.sourceId === sourceId ? zap.categoryId : undefined;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  // Played from a channel list: the panel shows that list, in its order, like zapping walks it.
  const listId = zap?.listId;
  const list = useListPages(listId, debounced, available && open);
  const inList = !!listId && !list.failed;
  const pages = useChannelPages(sourceId, categoryId, debounced, available && open && !inList);
  const { cache, error } = inList ? { cache: list.cache, error: null } : pages;
  const ensure = pages.ensure;
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

  /** Opened just now: the list goes to the playing channel and focus to its row (see below). */
  const arriving = useRef(false);
  useEffect(() => {
    if (!open) return;
    ensure(0);
    arriving.current = true;
    // The list holds focus while the playing channel is looked up, so the arrows work at once.
    const id = requestAnimationFrame(() => {
      if (arriving.current) scrollRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
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
  const virtualizer = useListVirtualizer({
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

  // Where the playing channel sits in the list (-1: not in it). A search lists other rows.
  const searching = debounced !== '';
  const currentKey = current ? itemKey(current) : null;
  const scope = `${inList ? `list:${listId}` : `${sourceId}|${categoryId ?? ''}`}|${currentKey}`;
  const [located, setLocated] = useState<{ scope: string; index: number } | null>(null);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const seed = pages.seed;
  useEffect(() => {
    if (!open || searching) return;
    if (!current) {
      setLocated({ scope, index: -1 });
      return;
    }
    const findLoaded = (): number => {
      for (const [p, rows] of cacheRef.current.pages) {
        const at = rows.findIndex((c) => c.ref.itemId === current.itemId && c.ref.sourceId === current.sourceId);
        if (at >= 0) return p * PAGE + at;
      }
      return -1;
    };
    if (inList) {
      // A list is read whole: its rows say.
      if (list.cache.total !== null) setLocated({ scope, index: findLoaded() });
      return;
    }
    const loaded = findLoaded();
    if (loaded >= 0 || !sourceId) {
      setLocated({ scope, index: loaded });
      return;
    }
    let stale = false;
    const ref = current;
    void fetchChannelInfo(ref)
      .then((info) => locateChannel((p) => rpc('catalog.channels', pageArgs(sourceId, categoryId, '', p)), ref, info.number, PAGE))
      .then(
        (found) => {
          if (stale) return;
          if (found) seed(found.page, found.items, found.total);
          setLocated({ scope, index: found ? found.index : -1 });
        },
        () => {
          if (!stale) setLocated({ scope, index: -1 });
        },
      );
    return () => {
      stale = true;
    };
    // `current` and the source are named by `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, searching, scope, inList, list.cache, seed]);
  const target = searching ? -1 : located?.scope === scope ? located.index : null;

  /** The row that takes Tab and the arrows (roving focus); null until one is chosen. */
  const [active, setActive] = useState<number | null>(null);
  /** Focus follows `active` once its row is drawn (its page may still be loading). */
  const focusRow = useRef(false);
  useEffect(() => setActive(null), [debounced, scope]);
  useEffect(() => {
    if (!open) setActive(null);
  }, [open]);

  // On arrival: centre the playing channel and focus its row or, when it is not in the list, the
  // search field, as before. Focus moves only if it is still where opening put it.
  useEffect(() => {
    if (!open || !arriving.current || target === null) return;
    arriving.current = false;
    const a = document.activeElement;
    const free = !a || a === scrollRef.current || a === document.body || !panelRef.current?.contains(a);
    if (target < 0 || target >= total) {
      if (free) searchRef.current?.focus({ preventScroll: true });
      return;
    }
    virtualizer.scrollToIndex(target, { align: 'center' });
    setActive(target);
    if (free) focusRow.current = true;
  }, [open, target, total, virtualizer]);

  const rowEl = (i: number): HTMLElement | null | undefined =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-index="${i}"] [role="option"]`);
  useEffect(() => {
    if (!focusRow.current || active === null) return;
    const row = rowEl(active);
    if (!row) return;
    focusRow.current = false;
    row.focus({ preventScroll: true });
  });

  /** Moves the roving focus to row `i`, scrolling it into view (focus waits for a row not drawn yet). */
  const moveTo = (i: number): void => {
    setActive(i);
    virtualizer.scrollToIndex(i, { align: 'auto' });
    const row = rowEl(i);
    focusRow.current = !row;
    row?.focus({ preventScroll: true });
  };

  /** Arrows, Page Up/Down, Home and End walk the rows; Enter plays (each row is a button). */
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || total === 0) return;
    const lastRow = total - 1;
    const from = active ?? (target !== null && target >= 0 ? target : -1);
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW) / ROW) - 1);
    let to: number;
    switch (e.key) {
      case 'ArrowDown':
        to = Math.min(lastRow, from + 1);
        break;
      case 'ArrowUp':
        if (from <= 0) {
          // Above the first row: back to the search field.
          e.preventDefault();
          e.stopPropagation();
          searchRef.current?.focus();
          return;
        }
        to = from - 1;
        break;
      case 'PageDown':
        to = Math.min(lastRow, Math.max(0, from) + pageRows);
        break;
      case 'PageUp':
        to = Math.max(0, from - pageRows);
        break;
      case 'Home':
        to = 0;
        break;
      case 'End':
        to = lastRow;
        break;
      default:
        // Typing on a row searches: the key goes on to the search field.
        if (e.key.length === 1 && e.key !== ' ') {
          e.stopPropagation();
          searchRef.current?.focus();
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    moveTo(to);
  };

  /** Down from the search field goes into the list: the playing channel, else the first row in view. */
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || total === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Enter on a search plays its first result.
    if (e.key === 'Enter' && searching) {
      const top = rowAt(0);
      if (top) void playChannel(top, undefined, inList ? { keepList: true } : undefined).catch(() => undefined);
      return;
    }
    const inView = Math.min(total - 1, Math.ceil((scrollRef.current?.scrollTop ?? 0) / ROW));
    moveTo(active ?? (target !== null && target >= 0 ? target : inView));
  };

  if (!available) return null;

  const isCurrent = (c: Channel): boolean =>
    !!current && c.ref.itemId === current.itemId && c.ref.sourceId === current.sourceId;
  const tabStop = active ?? (target !== null && target >= 0 ? target : first);

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
      {!open && !statsOpen && (
        <Tooltip content={t('openChannelPanel')} shortcut="c" tone="glass" describe={false}>
          <button
            type="button"
            aria-label={t('openChannelPanel')}
            aria-keyshortcuts="C"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={pressKeepsFocus}
            // Fades with the controls; hidden, it lets the pointer through like the rest of the chrome.
            className={cn(
              'player-glass player-glass-edge glass-blur absolute start-4 top-1/2 z-30 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full border text-on-glass hover:bg-white/12 pointer-coarse:size-11',
              'motion-safe:transition-opacity motion-safe:duration-200',
              !chromeVisible && 'pointer-events-none opacity-0',
            )}
          >
            <PanelLeftOpen className="size-5 rtl:-scale-x-100" aria-hidden />
          </button>
        </Tooltip>
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
          'player-glass-strong glass-blur absolute inset-y-0 start-0 z-40 flex w-[min(360px,85vw)] flex-col border-e text-on-glass shadow-2',
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
            onKeyDown={onSearchKeyDown}
            placeholder={t('searchChannels')}
            aria-label={t('searchChannels')}
            // Its own border colour outranks the base focus rule (a utility beats @layer base), so
            // it names the focus border itself; --color-focus is the glass accent over the player.
            className="h-9 min-w-0 flex-1 rounded-md border border-white/15 bg-white/6 px-3 text-body-sm text-on-glass placeholder:text-on-glass-muted focus-visible:border-focus pointer-coarse:h-11"
          />
          <Tooltip content={t('close')} tone="glass" describe={false}>
            <button
              type="button"
              aria-label={t('close')}
              onClick={() => setOpen(false)}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-on-glass-muted hover:bg-white/10 hover:text-on-glass pointer-coarse:size-11"
            >
              <X className="size-4" aria-hidden />
            </button>
          </Tooltip>
        </div>
        <div
          ref={scrollRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          role="listbox"
          aria-label={t('channels')}
          onKeyDown={onListKeyDown}
        >
          {error ? (
            <p role="status" className="px-4 py-6 text-center text-body-sm text-on-glass-muted">
              {t('channelsFailed')}
            </p>
          ) : cache.total === 0 ? (
            // A search that found nothing says what it looked for; an empty list says so plainly.
            <p role="status" className="px-4 py-6 text-center text-body-sm [overflow-wrap:anywhere] text-on-glass-muted">
              {searching ? t('noChannelsMatch', { query: debounced }) : t('noChannelsInList')}
            </p>
          ) : cache.total === null ? (
            <div className="space-y-1 p-2" aria-busy>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex h-12 items-center gap-3 px-2">
                  <span className="h-3 w-8 rounded-xs bg-white/8 motion-safe:animate-pulse" />
                  <span className="size-8 rounded-sm bg-white/8 motion-safe:animate-pulse" />
                  <span className="h-3 flex-1 rounded-xs bg-white/8 motion-safe:animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {/* guide: now line per row (XMLTV, else the provider's short guide). */}
              <PanelNowLines sourceId={sourceId} first={first} last={last} rowAt={rowAt}>
              {(nowFor) => items.map((v) => {
                const c = rowAt(v.index);
                return (
                  <div
                    key={v.key}
                    data-index={v.index}
                    className="absolute inset-x-0 px-2"
                    style={{ top: v.start, height: ROW }}
                  >
                    {c ? (
                      <button
                        type="button"
                        role="option"
                        aria-selected={isCurrent(c)}
                        tabIndex={v.index === tabStop ? 0 : -1}
                        onFocus={() => {
                          if (active !== v.index) setActive(v.index);
                        }}
                        onClick={() => void playChannel(c, undefined, inList ? { keepList: true } : undefined).catch(() => undefined)}
                        className={cn(
                          'flex h-[48px] w-full items-center gap-3 rounded-md px-2 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                          // The playing channel: the rail's tick on a neutral fill, never an amber wash.
                          isCurrent(c) ? 'tuning-tick bg-white/12' : 'hover:bg-white/8',
                        )}
                      >
                        <span className="w-10 shrink-0 text-end font-numeric text-body-sm text-on-glass-muted tabular-nums">
                          {c.number ?? ''}
                        </span>
                        <RowLogo url={c.logoUrl} sourceId={c.ref.sourceId} defer={virtualizer.isScrolling} />
                        {/* guide: name over the programme on now. */}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span dir="auto" className={cn('truncate text-body-sm text-match-parent', isCurrent(c) && 'font-medium')}>{c.name}</span>
                          {nowFor(c.ref) ? (
                            <span dir="auto" className="truncate text-caption text-on-glass-muted text-match-parent" data-testid="panel-now">
                              {nowFor(c.ref)?.title}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    ) : (
                      <div className="mt-1 h-10 rounded-md bg-white/6 motion-safe:animate-pulse" aria-hidden />
                    )}
                  </div>
                );
              })}
              </PanelNowLines>
            </div>
          )}
        </div>
        {/* guide: archive of the playing channel. */}
        {open ? <PanelArchiveButton /> : null}
      </aside>
    </>
  );
}
