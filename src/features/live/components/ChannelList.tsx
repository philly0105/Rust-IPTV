import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { UNSAFE_LocationContext } from 'react-router';

import { itemKey, sameRef, type Channel, type EpgNowNext, type ItemKey, type ItemRef, type SourceKind } from '@/api/types';
import { useRowHeight } from '@/ui';

import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import type { ParentalLocks } from '../hooks/useParentalLocks';
import { documentIsRtl } from '../lib/rtl';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, ChannelRow } from './ChannelRow';

export interface ChannelListProps {
  paged: PagedChannels;
  /** Changes whenever the list identity changes (category, search); scrolls back to the top. */
  resetKey: string;
  playingRef?: ItemRef;
  /** The playing channel's number: finds its row when it is outside the loaded pages. */
  playingNumber?: number;
  openOnDoubleClick: boolean;
  now: number;
  compact?: boolean;
  sourceKind?: SourceKind;
  /** Initial-height hint for tests and SSR-less environments. */
  initialHeight?: number;
  onPlay(channel: Channel, nowNext: EpgNowNext | undefined): void;
  onToggleFavorite(channel: Channel, favorite: boolean): void;
  /** `favorite` is the star state shown on the row, so the menu can say "Add" or "Remove". */
  onContextMenu(pos: { x: number; y: number }, channel: Channel, favorite: boolean): void;
  /** Optimistic star states (a toggle in flight) that win over the loaded `favorites.contains`. */
  favoriteOverrides?: ReadonlyMap<ItemKey, boolean>;
  /** Reports the channel under the keyboard cursor, once it has rested for ACTIVE_SETTLE_MS. */
  onActiveChange?(channel: Channel | undefined): void;
  /** Parental Ask mode: channels that ask for the PIN (rows show a lock and keep programmes back). */
  locks?: ParentalLocks;
}

interface ListPlace {
  active: number;
  scrollTop: number;
}

/** Cursor and scroll offset per list key, kept for the session (bounded, oldest dropped first). */
const listMemory = new Map<string, ListPlace>();
const LIST_MEMORY_LIMIT = 64;
/** The cursor has to rest this long before the parent (guide ribbon) follows it. */
export const ACTIVE_SETTLE_MS = 200;

function remember(key: string, patch: Partial<ListPlace>): void {
  const prev = listMemory.get(key) ?? { active: 0, scrollTop: 0 };
  listMemory.delete(key);
  listMemory.set(key, { ...prev, ...patch });
  if (listMemory.size > LIST_MEMORY_LIMIT) {
    const oldest = listMemory.keys().next().value;
    if (oldest !== undefined) listMemory.delete(oldest);
  }
}

/** Tests: forget every remembered list position. */
export function resetChannelListMemory(): void {
  listMemory.clear();
}

export function ChannelList(props: ChannelListProps) {
  const { t } = useTranslation('live');
  const { paged, resetKey, playingRef, playingNumber, now } = props;
  // Outside a router (tests) there is no navigation type: treat it as a push.
  const navigationType = useContext(UNSAFE_LocationContext)?.navigationType;
  const scrollRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Coming back to a list (route change, category round trip) restores where you were.
  const [active, setActiveState] = useState(() => listMemory.get(resetKey)?.active ?? 0);
  // Key repeat on a big list delivers keydowns faster than React renders: every handler reads the
  // cursor from this ref, so a burst of ArrowDowns moves one row each instead of re-reading a stale `active`.
  const activeRef = useRef(active);
  const setActive = useCallback((next: number | ((a: number) => number)) => {
    const value = typeof next === 'function' ? next(activeRef.current) : next;
    activeRef.current = value;
    setActiveState(value);
  }, []);
  /** Row index to focus once it is rendered (after keyboard moves and zaps). */
  const focusPending = useRef<number | null>(null);
  const count = paged.total ?? 0;
  const prefs = useDisplayPrefs();
  const { favoriteOverrides } = props;
  const isFavorite = useCallback(
    (i: number): boolean => {
      const ch = paged.getChannel(i);
      const o = ch ? favoriteOverrides?.get(itemKey(ch.ref)) : undefined;
      return o ?? paged.isFavorite(i);
    },
    [paged, favoriteOverrides],
  );

  // A remembered cursor can point past the end once the list shrank (channels removed, refresh):
  // clamp it once the total is known so one row keeps tabIndex 0 and Enter still plays.
  const knownTotal = paged.total;
  useEffect(() => {
    if (knownTotal === undefined) return;
    setActive((a) => Math.max(0, Math.min(a, knownTotal - 1)));
  }, [knownTotal]);

  // Rows follow the UI scale, and compact density tightens their padding and gaps.
  const rowHeight = useRowHeight(CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    initialRect: { width: 360, height: props.initialHeight ?? 800 },
    // First paint already shows the remembered rows: no flash of the top of the list.
    initialOffset: () => listMemory.get(resetKey)?.scrollTop ?? 0,
  });
  // A new scale or density: drop the cached row sizes so every row takes the new height.
  const measuredHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    if (measuredHeight.current === rowHeight) return;
    measuredHeight.current = rowHeight;
    virtualizer.measure();
  }, [rowHeight, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  const { setVisibleRange } = paged;
  useEffect(() => {
    setVisibleRange(first, last);
  }, [first, last, setVisibleRange]);

  // New list: back to where that list was left, else the top.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const saved = listMemory.get(resetKey);
    if (!mounted.current) {
      mounted.current = true;
      // initialOffset positioned the virtualizer; make the element agree with it.
      if (saved && scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop;
      // Back to a list you left (Back, a round trip through another page): keyboard focus returns to
      // the row you were on, unless something else already holds it. The list holds it until the row renders.
      // On Back, the shell's navigation (a sidebar link that opened the other page) does not count
      // as holding it: that link survives the route change but is not where the user was.
      const focused = document.activeElement;
      const main = scrollRef.current?.closest('main');
      const free = focused === null || focused === document.body || (!!main && focused === main);
      const inShell = !!main && !!focused && !main.contains(focused);
      if (saved && scrollRef.current && (free || (inShell && navigationType === 'POP'))) {
        scrollRef.current.focus({ preventScroll: true });
        focusPending.current = saved.active;
      }
      return;
    }
    // The old list's pending scroll read lands under the old list, before the new offset is set.
    flushScroll();
    setActive(saved?.active ?? 0);
    if (scrollRef.current) scrollRef.current.scrollTop = saved?.scrollTop ?? 0;
    virtualizer.scrollToOffset(saved?.scrollTop ?? 0);
  }, [resetKey]);

  // Remember the cursor per list.
  useEffect(() => {
    remember(resetKey, { active });
  }, [resetKey, active]);
  // One scrollTop read per frame, not per scroll event (a fling fires several between frames).
  // A read still pending when the list changes or unmounts is taken at once, under its own list.
  const scrollFrame = useRef(0);
  const scrollKey = useRef(resetKey);
  const flushScroll = useCallback(() => {
    if (!scrollFrame.current) return;
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    if (scrollRef.current) remember(scrollKey.current, { scrollTop: scrollRef.current.scrollTop });
  }, []);
  useLayoutEffect(() => flushScroll, [flushScroll]);
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollKey.current = resetKey;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (scrollRef.current) remember(scrollKey.current, { scrollTop: scrollRef.current.scrollTop });
    });
  };

  // The cursor follows the playing channel (zap, number entry, remote) once its row is loaded.
  const playingKey = playingRef ? `${playingRef.sourceId}|${playingRef.contentType}|${playingRef.itemId}` : '';
  // A remembered cursor wins on mount; with none, the playing channel's row is picked up.
  const followKey = useRef(listMemory.has(resetKey) ? '' : playingKey);
  const seenPlayingKey = useRef(playingKey);
  /** `playingKey|number|list` of the lookup under way for a channel outside the loaded pages. */
  const locating = useRef('');
  useEffect(() => {
    if (seenPlayingKey.current !== playingKey) {
      seenPlayingKey.current = playingKey;
      followKey.current = playingKey;
    }
    if (!followKey.current || !playingRef) return;
    const follow = (index: number, align: 'auto' | 'center') => {
      followKey.current = '';
      if (index === activeRef.current) return;
      setActive(index);
      virtualizer.scrollToIndex(index, { align });
      // Keep keyboard focus on the list when it was there.
      if (scrollRef.current?.contains(document.activeElement)) focusPending.current = index;
    };
    const hit = paged.loaded.find((l) => sameRef(l.channel.ref, playingRef));
    if (hit) {
      follow(hit.index, 'auto');
      return;
    }
    // Tuned outside the loaded pages (a number typed, a zap from elsewhere): find its row, jump
    // there and let the pages around it load. Once per channel and list.
    const lookup = `${playingKey}|${playingNumber ?? ''}|${resetKey}`;
    if (!paged.locate || playingNumber === undefined || locating.current === lookup) return;
    locating.current = lookup;
    const want = playingKey;
    const list = resetKey;
    void paged.locate(playingRef, playingNumber).then(
      (index) => {
        if (index === undefined || followKey.current !== want || propsRef.current.resetKey !== list) return;
        follow(index, 'center');
      },
      () => undefined,
    );
  }, [playingKey, playingNumber, paged.loaded, resetKey]);

  // The parent hears about the cursor once it settles. Telling it on every key (from an effect)
  // left a parent render queued behind each keystroke of a fast repeat, so no commit ever ended
  // idle and React stopped the chain as an update loop (#185).
  const activeChannel = paged.getChannel(active);
  const { onActiveChange } = props;
  useEffect(() => {
    if (!onActiveChange) return;
    const id = window.setTimeout(() => onActiveChange(activeChannel), ACTIVE_SETTLE_MS);
    return () => window.clearTimeout(id);
    // resetKey: a new list restarts the wait, so an old list's pending report never lands on it.
  }, [activeChannel, onActiveChange, resetKey]);

  /** The focusable button of row `i`: only there while the row is rendered and its channel is loaded. */
  const rowButton = (i: number) => scrollRef.current?.querySelector<HTMLButtonElement>(`button[data-row-index="${i}"]`) ?? null;
  /** The element in the list that last had focus, to notice when a re-render removes it. */
  const lastFocused = useRef<HTMLElement | null>(null);

  // Keyboard focus never sits on something that is about to disappear: while the cursor's row is
  // off screen or still loading, the list itself holds focus (and takes the keys), and focus moves
  // to the row as soon as it renders. A focused row removed by a reload hands focus to the list too.
  useLayoutEffect(() => {
    const list = scrollRef.current;
    if (!list) return;
    const focused = document.activeElement;
    if (lastFocused.current && !lastFocused.current.isConnected && (focused === document.body || focused === null)) {
      lastFocused.current = null;
      focusPending.current = activeRef.current;
      list.focus({ preventScroll: true });
    }
    const i = focusPending.current;
    if (i === null) return;
    if (!list.contains(document.activeElement)) {
      focusPending.current = null; // focus went elsewhere meanwhile: leave it there
      return;
    }
    const el = rowButton(i);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = null;
    }
  });

  const moveTo = useCallback(
    (i: number) => {
      if (count === 0) return;
      const next = Math.max(0, Math.min(count - 1, i));
      followKey.current = '';
      // In the event handler, not in a commit: the virtualizer answers the scroll from its own listener.
      virtualizer.scrollToIndex(next, { align: 'auto' });
      const el = scrollRef.current?.querySelector<HTMLButtonElement>(`button[data-row-index="${next}"]`);
      if (el) {
        el.focus({ preventScroll: true });
        focusPending.current = null;
      } else {
        scrollRef.current?.focus({ preventScroll: true });
        focusPending.current = next;
      }
      setActive(next);
    },
    [count, setActive, virtualizer],
  );

  const activate = useCallback(
    (index: number, how: 'click' | 'double' | 'key') => {
      setActive(index);
      const p = propsRef.current.paged;
      const ch = p.getChannel(index);
      if (!ch) return;
      const plays = how === 'key' || how === 'double' || (how === 'click' && !propsRef.current.openOnDoubleClick);
      if (plays) propsRef.current.onPlay(ch, p.getNowNext(index));
    },
    [],
  );

  const openMenuAtCursor = () => {
    const at = activeRef.current;
    const ch = paged.getChannel(at);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${at}"]`);
    if (ch && el) {
      const r = el.getBoundingClientRect();
      // Anchor near the row's inline start, which is its right edge in RTL.
      props.onContextMenu({ x: documentIsRtl() ? r.right - 48 : r.left + 48, y: r.bottom - 8 }, ch, isFavorite(at));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ctrl+S, Alt+Enter and friends belong to the app and the browser, not to the row.
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
    const active = activeRef.current;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 640) / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveTo(active + 1);
        break;
      case 'ArrowUp':
        moveTo(active - 1);
        break;
      case 'PageDown':
        moveTo(active + page);
        break;
      case 'PageUp':
        moveTo(active - page);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(count - 1);
        break;
      case 'Enter':
        if (!bare) return;
        // A held Enter must not restart the stream on every key repeat.
        if (!e.repeat) activate(active, 'key');
        break;
      case 's':
      case 'S': {
        if (!bare) return;
        const ch = paged.getChannel(active);
        if (ch && !e.repeat) props.onToggleFavorite(ch, isFavorite(active));
        break;
      }
      case 'ContextMenu':
        openMenuAtCursor();
        break;
      default:
        if (e.key === 'F10' && e.shiftKey) {
          openMenuAtCursor();
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const isFavoriteRef = useRef(isFavorite);
  isFavoriteRef.current = isFavorite;
  const onRowContext = useCallback(
    (e: MouseEvent, channel: Channel, index: number) => {
      e.preventDefault();
      setActive(index);
      // Focus the row, so Escape in the menu hands focus back to it (not to the search box or body).
      (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('button[data-row-index]')?.focus({ preventScroll: true });
      propsRef.current.onContextMenu({ x: e.clientX, y: e.clientY }, channel, isFavoriteRef.current(index));
    },
    [],
  );

  return (
    <>
      {paged.guideUnavailable ? <GuideUnavailableNotice onRetry={paged.retryGuide} /> : null}
      <div
        ref={scrollRef}
        role="list"
        aria-label={t('channelList')}
        data-testid="channel-list"
        aria-busy={paged.refreshing || undefined}
        // Focusable from script only: it holds focus while the cursor's row is still loading.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onFocus={(e) => {
          lastFocused.current = e.target as HTMLElement;
        }}
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset transition-opacity motion-reduce:transition-none ${
          paged.refreshing ? 'opacity-60' : ''
        }`}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((v) => {
            const ch = paged.getChannel(v.index);
            return (
              <div
                key={v.key}
                role="listitem"
                aria-setsize={count}
                aria-posinset={v.index + 1}
                data-index={v.index}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}
              >
                <ChannelRow
                  index={v.index}
                  channel={ch}
                  nowNext={paged.getNowNext(v.index)}
                  favorite={isFavorite(v.index)}
                  playing={!!ch && sameRef(ch.ref, playingRef)}
                  active={v.index === active}
                  compact={props.compact}
                  now={now}
                  sourceKind={props.sourceKind}
                  stripPrefix={prefs.stripCountryPrefix}
                  epgOffsetMinutes={prefs.epgOffsetMinutes}
                  guideUnavailable={paged.guideUnavailable}
                  locked={props.locks?.channelLocked(ch) ?? false}
                  onActivate={activate}
                  onToggleFavorite={props.onToggleFavorite}
                  onContextMenu={onRowContext}
                />
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** One line above a list or grid whose Stalker guide timed out; the queue retries on its own. */
export function GuideUnavailableNotice({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation('live');
  return (
    <div role="status" data-testid="guide-unavailable" className="flex items-center gap-2 border-b border-divider bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
      <span className="min-w-0 flex-1">{t('portalGuideUnavailable')}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t('retry')}
      </button>
    </div>
  );
}
