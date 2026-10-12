import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { sameRef, type Channel, type EpgNowNext, type ItemRef, type SourceKind } from '@/api/types';

import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import type { PagedChannels } from '../hooks/usePagedChannels';
import { CHANNEL_ROW_HEIGHT, ChannelRow } from './ChannelRow';

export interface ChannelListProps {
  paged: PagedChannels;
  /** Changes whenever the list identity changes (category, search); scrolls back to the top. */
  resetKey: string;
  playingRef?: ItemRef;
  openOnDoubleClick: boolean;
  now: number;
  compact?: boolean;
  sourceKind?: SourceKind;
  /** Initial-height hint for tests and SSR-less environments. */
  initialHeight?: number;
  onPlay(channel: Channel, nowNext: EpgNowNext | undefined): void;
  onToggleFavorite(channel: Channel, favorite: boolean): void;
  onContextMenu(pos: { x: number; y: number }, channel: Channel): void;
  /** Reports the channel under the keyboard cursor. */
  onActiveChange?(channel: Channel | undefined): void;
}

interface ListPlace {
  active: number;
  scrollTop: number;
}

/** Cursor and scroll offset per list key, kept for the session (bounded, oldest dropped first). */
const listMemory = new Map<string, ListPlace>();
const LIST_MEMORY_LIMIT = 64;

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
  const { paged, resetKey, playingRef, now } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Coming back to a list (route change, category round trip) restores where you were.
  const [active, setActive] = useState(() => listMemory.get(resetKey)?.active ?? 0);
  /** Row index to focus once it is rendered (after keyboard moves and zaps). */
  const focusPending = useRef<number | null>(null);
  const count = paged.total ?? 0;
  const prefs = useDisplayPrefs();

  // A remembered cursor can point past the end once the list shrank (channels removed, refresh):
  // clamp it once the total is known so one row keeps tabIndex 0 and Enter still plays.
  const knownTotal = paged.total;
  useEffect(() => {
    if (knownTotal === undefined) return;
    setActive((a) => Math.max(0, Math.min(a, knownTotal - 1)));
  }, [knownTotal]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANNEL_ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 360, height: props.initialHeight ?? 800 },
    // First paint already shows the remembered rows: no flash of the top of the list.
    initialOffset: () => listMemory.get(resetKey)?.scrollTop ?? 0,
  });
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
      return;
    }
    setActive(saved?.active ?? 0);
    if (scrollRef.current) scrollRef.current.scrollTop = saved?.scrollTop ?? 0;
    virtualizer.scrollToOffset(saved?.scrollTop ?? 0);
  }, [resetKey]);

  // Remember the cursor per list.
  useEffect(() => {
    remember(resetKey, { active });
  }, [resetKey, active]);
  const onScroll = () => {
    if (scrollRef.current) remember(resetKey, { scrollTop: scrollRef.current.scrollTop });
  };

  // The cursor follows the playing channel (zap, number entry, remote) once its row is loaded.
  const playingKey = playingRef ? `${playingRef.sourceId}|${playingRef.contentType}|${playingRef.itemId}` : '';
  // A remembered cursor wins on mount; with none, the playing channel's row is picked up.
  const followKey = useRef(listMemory.has(resetKey) ? '' : playingKey);
  const seenPlayingKey = useRef(playingKey);
  useEffect(() => {
    if (seenPlayingKey.current !== playingKey) {
      seenPlayingKey.current = playingKey;
      followKey.current = playingKey;
    }
    if (!followKey.current || !playingRef) return;
    const hit = paged.loaded.find((l) => sameRef(l.channel.ref, playingRef));
    if (!hit) return;
    followKey.current = '';
    if (hit.index === active) return;
    setActive(hit.index);
    virtualizer.scrollToIndex(hit.index, { align: 'auto' });
    // Keep keyboard focus on the list when it was there.
    if (scrollRef.current?.contains(document.activeElement)) focusPending.current = hit.index;
  }, [playingKey, paged.loaded]);

  const activeChannel = paged.getChannel(active);
  const { onActiveChange } = props;
  useEffect(() => {
    onActiveChange?.(activeChannel);
  }, [activeChannel, onActiveChange]);

  // After keyboard moves, focus the row button once it is rendered.
  useEffect(() => {
    if (focusPending.current === null) return;
    const el = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${focusPending.current}"]`);
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
      focusPending.current = next;
      setActive(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [count, virtualizer],
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 640) / CHANNEL_ROW_HEIGHT) - 1);
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
        activate(active, 'key');
        break;
      case 's':
      case 'S': {
        const ch = paged.getChannel(active);
        if (ch) props.onToggleFavorite(ch, paged.isFavorite(active));
        break;
      }
      case 'ContextMenu': {
        const ch = paged.getChannel(active);
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`);
        if (ch && el) {
          const r = el.getBoundingClientRect();
          props.onContextMenu({ x: r.left + 48, y: r.bottom - 8 }, ch);
        }
        break;
      }
      default:
        if (e.key === 'F10' && e.shiftKey) {
          const ch = paged.getChannel(active);
          const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`);
          if (ch && el) {
            const r = el.getBoundingClientRect();
            props.onContextMenu({ x: r.left + 48, y: r.bottom - 8 }, ch);
          }
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onRowContext = useCallback(
    (e: MouseEvent, channel: Channel, index: number) => {
      e.preventDefault();
      setActive(index);
      propsRef.current.onContextMenu({ x: e.clientX, y: e.clientY }, channel);
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
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain transition-opacity motion-reduce:transition-none ${
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
                  favorite={paged.isFavorite(v.index)}
                  playing={!!ch && sameRef(ch.ref, playingRef)}
                  active={v.index === active}
                  compact={props.compact}
                  now={now}
                  sourceKind={props.sourceKind}
                  stripPrefix={prefs.stripCountryPrefix}
                  epgOffsetMinutes={prefs.epgOffsetMinutes}
                  guideUnavailable={paged.guideUnavailable}
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
    <div role="status" data-testid="guide-unavailable" className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-xs text-fg-muted">
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
