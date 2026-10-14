import { Tv } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type EpgNowNext, type EpgProgram, type ItemRef } from '@/api/types';
import { formatClock, ms } from '@/features/live/lib/epgTime';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { airedShare, fetchNowNext, peekNowNext } from '../nowNext';
import { usePlayerStore } from '../store';
import { fetchChannelInfo, peekChannelInfo, useZapBanner, type ZapChannelInfo } from '../zapBanner';
import { useZapBannerShown, useZapHover } from './zapHooks';

interface ZapData {
  key: string | null;
  info?: ZapChannelInfo;
  /** undefined while loading, null when the guide has nothing. */
  guide?: EpgNowNext | null;
}

/** Number, logo and now/next for `ref`: the caches first, then one lookup each. */
function useZapData(ref: ItemRef | undefined, now: number): ZapData {
  const key = ref ? itemKey(ref) : null;
  const [data, setData] = useState<ZapData>({ key: null });
  // The airing programme ended while the banner is up (a hover across the hour): ask again.
  const airing = data.key === key ? data.guide?.now : undefined;
  const ended = !!airing && ms(airing.end) <= now;
  useEffect(() => {
    if (!ref || !key) return;
    let stale = false;
    const info = peekChannelInfo(ref);
    const guide = ended ? undefined : peekNowNext(ref);
    setData({ key, info, guide });
    if (!info) {
      void fetchChannelInfo(ref).then((i) => {
        if (!stale) setData((d) => (d.key === key ? { ...d, info: i } : d));
      });
    }
    if (guide === undefined) {
      void fetchNowNext(ref, { force: ended }).then((g) => {
        if (!stale) setData((d) => (d.key === key ? { ...d, guide: g } : d));
      });
    }
    return () => {
      stale = true;
    };
    // `ref` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ended]);
  if (data.key === key) return data;
  return ref ? { key, info: peekChannelInfo(ref), guide: peekNowNext(ref) } : { key };
}

/** A clock for the progress bar while the banner is up (programmes move slowly: every 5 s). */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Logo({ url, compact }: { url: string | undefined; compact: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const src = safeImageUrl(url);
  const box = compact ? 'size-9 rounded-sm' : 'size-14 rounded-md';
  if (!src || failed) {
    return (
      <span
        data-testid="zap-logo-fallback"
        className={cn('player-on-glass-muted flex shrink-0 items-center justify-center bg-white/8 ring-1 ring-white/10', box)}
        aria-hidden
      >
        <Tv className={compact ? 'size-4' : 'size-6'} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      data-testid="zap-logo"
      className={cn('shrink-0 bg-white/8 object-contain p-1 ring-1 ring-white/10', box)}
      onError={() => setFailed(true)}
    />
  );
}

/** How far into the programme, as a thin bar lit in the accent like the seek bar. */
function Progress({ share, className }: { share: number; className?: string }) {
  return (
    <div className={cn('h-[3px] overflow-hidden rounded-full bg-white/15', className)} aria-hidden>
      <div data-testid="zap-progress" className="h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
    </div>
  );
}

/** The programme airing at `now` and the one after it, from a guide answer that may have aged. */
export function airingPair(guide: EpgNowNext | null | undefined, now: number): { current?: EpgProgram; upcoming?: EpgProgram } {
  if (!guide) return {};
  const airs = (p: EpgProgram | undefined): p is EpgProgram => !!p && ms(p.start) <= now && ms(p.end) > now;
  // The guide's "now" ended while the banner was up: its next is what airs.
  const current = airs(guide.now) ? guide.now : airs(guide.next) ? guide.next : undefined;
  const upcoming = current !== guide.next && guide.next && ms(guide.next.end) > now ? guide.next : undefined;
  const out: { current?: EpgProgram; upcoming?: EpgProgram } = {};
  if (current) out.current = current;
  if (upcoming) out.upcoming = upcoming;
  return out;
}

function GuideRows({ guide, now, compact }: { guide: EpgNowNext | null | undefined; now: number; compact: boolean }) {
  const { t, i18n } = useTranslation('player');
  const lang = i18n.language;
  if (guide === undefined) {
    return (
      <div
        className={cn('space-y-1.5', compact ? 'mt-1.5' : 'mt-2.5')}
        role="status"
        aria-label={t('zapLoadingGuide')}
        data-testid="zap-guide-loading"
      >
        <div className="h-3 w-3/4 rounded-sm bg-white/10 motion-safe:animate-pulse" />
        {!compact && <div className="h-3 w-1/2 rounded-sm bg-white/8 motion-safe:animate-pulse" />}
      </div>
    );
  }
  const { current, upcoming } = airingPair(guide, now);
  if (!current && !upcoming) {
    return (
      <p data-testid="zap-no-guide" className={cn('player-on-glass-muted text-sm', compact ? 'mt-1' : 'mt-2')}>
        {t('zapNoGuide')}
      </p>
    );
  }
  const minutesLeft = current ? Math.max(1, Math.ceil((ms(current.end) - now) / 60_000)) : 0;

  if (compact) {
    // One line: what airs and how long it has left, the bar under it.
    const shown = (current ?? upcoming)!;
    return (
      <div className="mt-1" data-testid="zap-now">
        <div className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate" title={shown.title}>
            {shown.title}
          </span>
          <span className="player-on-glass-muted shrink-0 tabular-nums">
            {current ? t('zapMinutesLeft', { minutes: minutesLeft }) : formatClock(ms(shown.start), lang)}
          </span>
        </div>
        {current && <Progress share={airedShare(current, now)} className="mt-1" />}
      </div>
    );
  }

  // Labels in a column of their own, as wide as the longest one in the language.
  return (
    <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-sm">
      {current && (
        <>
          <span className="player-on-glass-muted text-xs font-medium">{t('zapNow')}</span>
          <span data-testid="zap-now" className="truncate" title={current.title}>
            {current.title}
          </span>
          <span className="player-on-glass-muted text-xs tabular-nums">
            {formatClock(ms(current.start), lang)}–{formatClock(ms(current.end), lang)}
            <span className="sr-only">, {t('zapMinutesLeft', { minutes: minutesLeft })}</span>
          </span>
          <Progress share={airedShare(current, now)} className="col-span-2 col-start-2 mb-1 self-center" />
        </>
      )}
      {upcoming && (
        <>
          <span className="player-on-glass-muted text-xs font-medium">{t('zapNext')}</span>
          <span data-testid="zap-next" className="player-on-glass-muted truncate" title={upcoming.title}>
            {upcoming.title}
          </span>
          <span className="player-on-glass-muted text-xs tabular-nums">{formatClock(ms(upcoming.start), lang)}</span>
        </>
      )}
    </div>
  );
}

/**
 * The tuner's info banner (C5): logo, number, name, and what airs now (with how far in) and
 * next. Up for 5 s on every live channel change and while the channel title is hovered; see
 * `zapBanner.ts`. Over embedded mpv it is cut out of the native video (`data-mpv-overlay`).
 * The caller places it (`className`: position and insets); `compact` is the one-line version
 * for the mini player and picture-in-picture.
 */
export function ZapBanner({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { t } = useTranslation('player');
  const shown = useZapBannerShown();
  const showing = useZapBanner((s) => s.showing);
  const source = usePlayerStore((s) => s.source);
  const now = useClock(shown);
  const ref = shown ? source?.ref : undefined;
  const { info, guide } = useZapData(ref, now);
  const hover = useZapHover();

  // The zap readout (number and name, top corner) says what the banner says: drop it.
  const title = source?.title;
  useEffect(() => {
    if (!shown) return;
    const osd = useMediaStore.getState().osd;
    if (osd && title && (osd.primary === title || osd.secondary === title)) useMediaStore.setState({ osd: undefined });
  }, [shown, showing, title]);

  if (!shown || !source || !ref) return null;
  const number = info?.number;
  const logo = info?.logoUrl ?? source.posterUrl;

  return (
    <div
      key={showing}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t('zapBannerLabel')}
      data-testid="zap-banner"
      data-mpv-overlay=""
      data-mpv-reserved=""
      className={cn(
        'player-glass player-glass-edge pointer-events-auto absolute z-[12] border motion-safe:animate-pop-in',
        compact ? 'rounded-md px-2.5 py-2' : 'w-[min(30rem,calc(100%-1.5rem))] rounded-xl p-3 sm:p-3.5',
        className,
      )}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={cn('flex min-w-0 items-start', compact ? 'gap-2' : 'gap-3')}>
        <Logo url={logo} compact={compact} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {number !== undefined && (
              // The tuner digit: the dial's accent on the dark themes, glass white on the light one.
              <span
                data-testid="zap-number"
                className={cn(
                  'shrink-0 font-display leading-none text-white tabular-nums dark:text-accent-hover',
                  compact ? 'text-lg' : 'text-3xl',
                )}
              >
                {number}
              </span>
            )}
            <span
              data-testid="zap-title"
              className={cn('min-w-0 truncate font-display leading-tight', compact ? 'text-sm' : 'text-lg')}
              title={source.title}
            >
              {source.title}
            </span>
          </div>
          <GuideRows guide={guide} now={now} compact={compact} />
        </div>
      </div>
    </div>
  );
}
