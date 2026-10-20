import { Radio, Tv, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import { useImageChain } from '@/ui/image';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { currentLiveKey, playHistoryEntry, setHistoryOpen, useHistoryStore, type HistoryEntry } from '../history';
import { getSettings, usePlayerStore } from '../store';
import { MENU_HEADER, menuFrameClass, menuFrameStyle, UNMEASURED, type MenuFit } from './menuFrame';

/** What airs now on each history channel, fetched once per opening. */
function useNowPlaying(entries: readonly HistoryEntry[]): Record<string, string> {
  const [now, setNow] = useState<Record<string, string>>({});
  const refsKey = entries.map((e) => e.key).join('\n');
  useEffect(() => {
    if (entries.length === 0) return;
    let stale = false;
    void (async () => {
      try {
        const settings = await getSettings();
        const offset = settings?.epgOffsetMinutes;
        const refs = entries.map((e) => e.ref);
        // Titles only: no descriptions.
        const res = await rpc('epg.nowNext', offset ? { refs, offsetMinutes: offset, withDescription: false } : { refs, withDescription: false });
        if (stale) return;
        const out: Record<string, string> = {};
        for (const e of entries) {
          const title = res[e.key]?.now?.title;
          if (title) out[e.key] = title;
        }
        setNow(out);
      } catch {
        // No guide: the list still works without it.
      }
    })();
    return () => {
      stale = true;
    };
    // Re-fetch only when the set of channels changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refsKey]);
  return now;
}

function Logo({ entry }: { entry: HistoryEntry }) {
  // Through the image cache (C3), then the logo's own URL once, then the icon.
  const logo = useImageChain([safeImageUrl(entry.posterUrl)], entry.ref.sourceId);
  if (!logo.url) {
    const Icon = entry.isRadio ? Radio : Tv;
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-white/8 text-on-glass-muted ring-1 ring-white/10" aria-hidden>
        <Icon className="size-4" />
      </span>
    );
  }
  return <img src={logo.url} alt="" aria-hidden className="size-8 shrink-0 rounded-sm bg-white/8 object-contain p-0.5 ring-1 ring-white/10" onError={logo.onError} />;
}

/**
 * Channels watched this session (Shift+B or the History row of the options menu). Arrow keys
 * move, Enter plays, Escape closes. A `role="menu"`, so embedded mpv cuts it out of the native
 * video like the other player menus. `fit`: a popover as tall as the room above the bar, or a
 * sheet in a short player (Controls measures it); its header stays in view while the list scrolls.
 */
export function ChannelHistory({ fit = UNMEASURED }: { fit?: MenuFit }) {
  const { t } = useTranslation('player');
  const { t: tc } = useTranslation('common');
  const entries = useHistoryStore((s) => s.entries);
  usePlayerStore((s) => s.source);
  const current = currentLiveKey();
  const now = useNowPlaying(entries);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    // Start on the channel B would switch to: the first one that is not playing.
    const first = items.find((el) => el.getAttribute('aria-current') !== 'true') ?? items[0];
    (first ?? ref.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }, []);

  const pick = (entry: HistoryEntry): void => {
    setHistoryOpen(false);
    if (entry.key !== current) void playHistoryEntry(entry).catch(() => undefined);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('channelHistory')}
      data-testid="channel-history"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setHistoryOpen(false);
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          e.stopPropagation();
          const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button') ?? []);
          const i = items.indexOf(document.activeElement as HTMLElement);
          const n = items.length;
          const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          items[to]?.focus();
        }
      }}
      data-sheet={fit.sheet ? '' : undefined}
      style={menuFrameStyle(fit, '60vh, 420px')}
      className={menuFrameClass(fit, 'max-h-[min(60vh,420px)] w-72 max-w-[calc(100vw-1rem)]')}
    >
      {/* The options menu's header: the title, then Close. */}
      <div className={MENU_HEADER}>
        <span className="flex-1 px-2 py-1.5 text-body-sm font-medium">{t('channelHistory')}</span>
        <Tooltip content={tc('close')} tone="glass" describe={false}>
          <button
            type="button"
            aria-label={tc('close')}
            onClick={() => setHistoryOpen(false)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-on-glass-muted hover:bg-white/10 hover:text-on-glass pointer-coarse:size-10"
          >
            <X className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-3 text-body-sm text-on-glass-muted">{t('channelHistoryEmpty')}</p>
      ) : (
        entries.map((entry) => {
          const playing = entry.key === current;
          const airing = now[entry.key];
          return (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              aria-current={playing ? 'true' : undefined}
              onClick={() => pick(entry)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-start pointer-coarse:min-h-[calc(44rem/15)]',
                // The channel on now: the rail's tick on a neutral fill, as in the channel list.
                playing ? 'tuning-tick bg-white/12' : 'hover:bg-white/10 focus-visible:bg-white/10',
              )}
            >
              <Logo entry={entry} />
              <span className="min-w-0 flex-1">
                <span dir="auto" className={cn('block truncate text-body-sm', playing && 'font-medium')}>
                  {entry.title}
                </span>
                <span dir="auto" className="block truncate text-caption text-on-glass-muted">
                  {playing ? t('channelHistoryWatching') : (airing ?? ' ')}
                </span>
              </span>
            </button>
          );
        })
      )}
      {entries.length === 1 && current === entries[0]?.key && <p className="px-3 pt-1 pb-2 text-caption text-on-glass-muted">{t('channelHistoryEmpty')}</p>}
    </div>
  );
}
