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

export function ChannelList(props: ChannelListProps) {
  const { t } = useTranslation('live');
  const { paged, resetKey, playingRef, now } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [active, setActive] = useState(0);
  const focusPending = useRef(false);
  const count = paged.total ?? 0;
  const prefs = useDisplayPrefs();

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHANNEL_ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 360, height: props.initialHeight ?? 800 },
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items[items.length - 1]?.index ?? 0;

  const { setVisibleRange } = paged;
  useEffect(() => {
    setVisibleRange(first, last);
  }, [first, last, setVisibleRange]);

  // New list: back to the top.
  useLayoutEffect(() => {
    setActive(0);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  const activeChannel = paged.getChannel(active);
  const { onActiveChange } = props;
  useEffect(() => {
    onActiveChange?.(activeChannel);
  }, [activeChannel, onActiveChange]);

  // After keyboard moves, focus the row button once it is rendered.
  useEffect(() => {
    if (!focusPending.current) return;
    const el = scrollRef.current?.querySelector<HTMLButtonElement>(`[data-row-index="${active}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      focusPending.current = false;
    }
  });

  const moveTo = useCallback(
    (i: number) => {
      if (count === 0) return;
      const next = Math.max(0, Math.min(count - 1, i));
      focusPending.current = true;
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
    <div
      ref={scrollRef}
      role="list"
      aria-label={t('channelList')}
      data-testid="channel-list"
      onKeyDown={onKeyDown}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
                onActivate={activate}
                onToggleFavorite={props.onToggleFavorite}
                onContextMenu={onRowContext}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
