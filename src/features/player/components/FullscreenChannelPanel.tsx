import { QueryClientContext } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import { itemKey, type Channel, type ItemRef } from '@/api/types';
import { ChannelName } from '@/features/live/components/ChannelLogo';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { useNow } from '@/features/live/hooks/useNow';
import { usePagedChannels } from '@/features/live/hooks/usePagedChannels';
import { useShortEpgEnabled } from '@/features/live/hooks/useShortEpg';
import { monogramFill, monogramText } from '@/features/live/lib/monogram';
import { useImageChain } from '@/ui/image';
import { gateImage } from '@/ui/imageGate';
import { useListVirtualizer } from '@/ui/virtualizer';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { focusIsLost, safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { peekSettings, playChannel, usePlayerStore } from '../store';
import { fetchChannelInfo } from '../zapBanner';
import { PanelArchiveButton, PanelNowLines } from './ChannelPanelGuide';

/**
 * A row's channel logo through the image cache (C3), then its own URL once and the cache again,
 * then the channel's coloured monogram, the tile the Live list, the guide and the zap banner draw.
 * Fetched through the shared image gate (ui/imageGate.ts), as ChannelLogo's: at most `maxActive()`
 * at once (4 in server mode, 6 on desktop), the rows in view first, and a row that leaves before
 * its turn asks nothing. `defer` (the list is scrolling) is RowLogo's own latch on top of the gate:
 * `allowed` holds the last address let through, so a logo not showing yet waits for the scroll to
 * rest before it reaches the gate, and one already showing stays, since its <img> is kept while the
 * address is the same.
 */
function RowLogo({ url, name, sourceId, defer = false }: { url?: string | null; name: string; sourceId: string; defer?: boolean }) {
  const image = useImageChain([safeImageUrl(url ?? undefined)], sourceId, 32);
  const src = image.url;
  // The address last allowed to load: a reused row that shows another channel while `defer` holds waits.
  const [allowed, setAllowed] = useState(defer ? undefined : src);
  if (!defer && allowed !== src) setAllowed(src);
  const waiting = defer && allowed !== src;
  // One <img> per address (keyed below): React renders no `src`, the gate sets it.
  const imgRef = useCallback((el: HTMLImageElement | null) => (el && src ? gateImage(el, src) : undefined), [src]);
  if (!src && name.trim()) {
    return (
      <span
        aria-hidden
        data-monogram=""
        className="flex size-8 shrink-0 items-center justify-center rounded-sm font-display text-xs leading-none font-semibold tracking-tight text-white ring-1 ring-white/10"
        style={{ background: monogramFill(name) }}
      >
        {monogramText(name)}
      </span>
    );
  }
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

const ROW = 52;
const OPEN_DWELL_MS = 160;
const CLOSE_GRACE_MS = 420;

/** The panel's notion of the playing channel's row (the store's ref may lack a content type). */
function isChannel(c: Channel, ref: ItemRef): boolean {
  return c.ref.itemId === ref.itemId && c.ref.sourceId === ref.sourceId;
}

interface PanelRowProps {
  channel: Channel;
  index: number;
  current: boolean;
  tabStop: boolean;
  /** The programme on now (XMLTV, else the provider's short guide). */
  nowTitle: string | undefined;
  defer: boolean;
  strip: boolean | undefined;
  onFocusRow(index: number): void;
  onPlay(channel: Channel): void;
}

/**
 * One channel row. Memoized (F2-1): a page landing, the guide answering or a keystroke in the
 * search field re-renders only the rows whose props changed, not all of the 35 or so drawn, each
 * with its logo's image-chain hooks.
 */
const PanelRow = memo(function PanelRow({ channel: c, index, current, tabStop, nowTitle, defer, strip, onFocusRow, onPlay }: PanelRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={current}
      tabIndex={tabStop ? 0 : -1}
      onFocus={() => onFocusRow(index)}
      onClick={() => onPlay(c)}
      className={cn(
        'flex h-[48px] w-full items-center gap-3 rounded-md px-2 text-start focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
        // The playing channel: the rail's tick on a neutral fill, never an amber wash.
        current ? 'tuning-tick bg-white/12' : 'hover:bg-white/8',
      )}
    >
      <span className="w-10 shrink-0 text-end font-numeric text-body-sm text-on-glass-muted tabular-nums">{c.number ?? ''}</span>
      <RowLogo url={c.logoUrl} name={c.name} sourceId={c.ref.sourceId} defer={defer} />
      {/* guide: name over the programme on now. */}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Named as the channel lists name it: the country tag after the name, quiet, or none with the setting. */}
        <ChannelName
          name={c.name}
          strip={strip}
          className={cn('truncate text-body-sm text-match-parent', current && 'font-medium')}
          tagClassName="text-on-glass-muted"
        />
        {nowTitle ? (
          <span dir="auto" className="truncate text-caption text-on-glass-muted text-match-parent" data-testid="panel-now">
            {nowTitle}
          </span>
        ) : null}
      </span>
    </button>
  );
});

/**
 * The channels of the channel list being zapped (lists.items), in list order. A list holds at
 * most 2000 channels, so it is read whole and searched here. `failed`: the list cannot be read
 * (deleted meanwhile): use the source instead.
 */
function useListRows(listId: string | undefined, search: string, enabled: boolean): { rows: Channel[] | null; failed: boolean } {
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

  const rows = useMemo(() => {
    if (!channels) return null;
    const q = search.toLocaleLowerCase();
    return q ? channels.filter((c) => c.name.toLocaleLowerCase().includes(q)) : channels;
  }, [channels, search]);

  return { rows, failed };
}

/**
 * Slide-in channel list inside the fullscreen player. Opens with C, a dwell on the left
 * edge, a tap there, or the control bar's Channel list button (`Controls` `channelPanel`; touch
 * screens have no edge to dwell on); closes on pointer leave (with grace), Escape, C, or a click
 * on the video.
 *
 * The source's channels come through the query cache, Live's pages included, so the panel needs
 * the app's query provider; a bare mount without one (some player tests) draws no panel.
 */
export function FullscreenChannelPanel(props: { available: boolean }) {
  return useContext(QueryClientContext) ? <ChannelPanel {...props} /> : null;
}

function ChannelPanel({ available }: { available: boolean }) {
  const { t } = useTranslation('player');
  const open = useMediaStore((s) => s.channelPanelOpen);
  const zap = usePlayerStore((s) => s.zapContext);
  const current = usePlayerStore((s) => s.source?.ref);
  const sourceId = zap?.sourceId ?? current?.sourceId;
  const categoryId = zap && zap.sourceId === sourceId ? zap.categoryId : undefined;
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  // Played from a channel list: the panel shows that list, in its order, like zapping walks it.
  const listId = zap?.listId;
  const list = useListRows(listId, debounced, available && open);
  const inList = !!listId && !list.failed;

  // The source's channels are Live's own pages (F2-1): playlist order (the order Live lists and
  // channel up and down walk), Live's page size and query keys, so a page Live holds opens at
  // once. A scrollbar drag reads only where it rests (PAGE_SETTLE_MS) and far read-ahead is
  // cancelled. Before, the panel read 100-row pages sorted by number, which no index covers: on a
  // 200k-channel source 22-63 ms a deep page against 2-4 ms, and 112-224 ms for a late group's
  // first page against 0.02 ms, one read per page a drag passed, and page 0 again on every open.
  // An empty source id asks nothing: the panel is mounted for the whole fullscreen session.
  const pagedSource = open && available && !inList && sourceId ? sourceId : '';
  const prefs = useDisplayPrefs();
  const now = useNow(30_000);
  const source = useRpcQuery('sources.get', { id: sourceId ?? '' }, { enabled: !!pagedSource, staleTime: 5 * 60_000 });
  const shortEpg = useShortEpgEnabled(source.data?.kind);
  const paged = usePagedChannels({
    sourceId: pagedSource,
    categoryId,
    search: debounced,
    // Closed, the rows it slides out with keep the guide lines already cached, and ask nothing.
    withExtras: open,
    // No star in the panel.
    favorites: false,
    shortEpg,
    epgOffsetMinutes: prefs.epgOffsetMinutes,
    // Closed, a programme ending on a cached row must not refresh the guide for everyone.
    now: open ? now : undefined,
  });
  const { getChannel, getNowNext, setVisibleRange, locate, loaded } = paged;

  // Null until the list's first rows arrive. While open, a new list (a search, a group) shows the
  // skeleton until its first page lands, as before, instead of the last list's rows; once closed
  // those rows (the hook's placeholder) stay for the slide out.
  const rowsTotal: number | null = inList ? (list.rows?.length ?? null) : open && paged.refreshing ? null : (paged.total ?? null);
  const error = inList ? null : paged.error;
  const listRows = list.rows;
  const rowAt = useCallback((i: number): Channel | undefined => (inList ? listRows?.[i] : getChannel(i)), [inList, listRows, getChannel]);

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
    arriving.current = true;
    // The list holds focus while the playing channel is looked up, so the arrows work at once.
    const id = requestAnimationFrame(() => {
      if (arriving.current) scrollRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

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

  const total = rowsTotal ?? 0;
  const virtualizer = useListVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;
  // The hook reads the one or two pages that cover the rows in view, once the range rests.
  useEffect(() => {
    if (open && !inList) setVisibleRange(first, last);
  }, [open, inList, first, last, setVisibleRange]);

  // Where the playing channel sits in the list (-1: not in it). A search lists other rows.
  const searching = debounced !== '';
  const currentKey = current ? itemKey(current) : null;
  const scope = `${inList ? `list:${listId}` : `${sourceId}|${categoryId ?? ''}`}|${currentKey}`;
  const [located, setLocated] = useState<{ scope: string; index: number } | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // `locate` needs the list's length: it waits for the first page of this list.
  const ready = inList ? listRows !== null : paged.total !== undefined && !paged.refreshing;
  useEffect(() => {
    if (!open || searching) return;
    if (!current) {
      setLocated({ scope, index: -1 });
      return;
    }
    if (!ready) return;
    if (inList) {
      // A list is read whole: its rows say.
      setLocated({ scope, index: listRows?.findIndex((c) => isChannel(c, current)) ?? -1 });
      return;
    }
    const hit = loadedRef.current.find((l) => isChannel(l.channel, current));
    if (hit || !sourceId || !locate) {
      setLocated({ scope, index: hit ? hit.index : -1 });
      return;
    }
    // Outside the loaded pages: its channel number guides the page reads (as Live's list finds
    // a channel tuned elsewhere). Providers that number out of playlist order may not be found
    // in a few reads; the search field then takes focus, as for a channel not in the list.
    let stale = false;
    const ref = current;
    void fetchChannelInfo(ref)
      .then((info) => locate(ref, info.number))
      .then(
        (index) => {
          if (!stale) setLocated({ scope, index: index ?? -1 });
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
  }, [open, searching, scope, inList, ready, listRows, locate]);
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

  const onPlay = useCallback((c: Channel) => void playChannel(c, undefined, inList ? { keepList: true } : undefined).catch(() => undefined), [inList]);

  /** Down from the search field goes into the list: the playing channel, else the first row in view. */
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing || total === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Enter on a search plays its first result.
    if (e.key === 'Enter' && searching) {
      const top = rowAt(0);
      if (top) onPlay(top);
      return;
    }
    const inView = Math.min(total - 1, Math.ceil((scrollRef.current?.scrollTop ?? 0) / ROW));
    moveTo(active ?? (target !== null && target >= 0 ? target : inView));
  };

  if (!available) return null;
  // Read as the player names what it plays (the store's channel titles); the panel draws again
  // each time it opens.
  const strip = peekSettings()?.stripCountryPrefix;

  const tabStop = active ?? (target !== null && target >= 0 ? target : first);
  const rows = (nowTitleAt: (index: number, channel: Channel) => string | undefined) =>
    items.map((v) => {
      const c = rowAt(v.index);
      return (
        <div key={v.key} data-index={v.index} className="absolute inset-x-0 px-2" style={{ top: v.start, height: ROW }}>
          {c ? (
            <PanelRow
              channel={c}
              index={v.index}
              current={!!current && isChannel(c, current)}
              tabStop={v.index === tabStop}
              nowTitle={nowTitleAt(v.index, c)}
              defer={virtualizer.isScrolling}
              strip={strip}
              onFocusRow={setActive}
              onPlay={onPlay}
            />
          ) : (
            <div className="mt-1 h-10 rounded-md bg-white/6 motion-safe:animate-pulse" aria-hidden />
          )}
        </div>
      );
    });

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
          ) : rowsTotal === 0 ? (
            // A search that found nothing says what it looked for; an empty list says so plainly.
            <p role="status" className="px-4 py-6 text-center text-body-sm [overflow-wrap:anywhere] text-on-glass-muted">
              {searching ? t('noChannelsMatch', { query: debounced }) : t('noChannelsInList')}
            </p>
          ) : rowsTotal === null ? (
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
              {/* guide: now line per row (XMLTV, else the provider's short guide). The source's
                  pages bring theirs (one `epg.nowNext` per page, shared with Live); a list's rows,
                  from any source, ask in windows of the rows in view. */}
              {inList ? (
                <PanelNowLines sourceId={sourceId} first={first} last={last} rowAt={rowAt}>
                  {(nowFor) => rows((_, c) => nowFor(c.ref)?.title)}
                </PanelNowLines>
              ) : (
                rows((i) => getNowNext(i)?.now?.title)
              )}
            </div>
          )}
        </div>
        {/* guide: archive of the playing channel. */}
        {open ? <PanelArchiveButton /> : null}
      </aside>
    </>
  );
}
