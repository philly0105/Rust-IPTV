import { Lock, Tv } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type EpgNowNext, type EpgProgram, type ItemRef } from '@/api/types';
import { formatClock, ms } from '@/features/live/lib/epgTime';
import { useImageChain } from '@/ui/image';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { airedShare, fetchNowNext, peekNowNext } from '../nowNext';
import { isLockedZap, usePlayerStore } from '../store';
import { fetchChannelInfo, peekChannelInfo, useZapBanner, type ZapChannelInfo } from '../zapBanner';
import { useZapBannerShown, useZapHover } from './zapHooks';

interface ZapData {
  key: string | null;
  info?: ZapChannelInfo;
  /** undefined while loading, null when the guide has nothing (or is not asked: locked). */
  guide?: EpgNowNext | null;
  locked?: boolean;
}

/**
 * Number, logo and now/next for `ref`: the caches first, then one lookup each. `locked`: a zap
 * passing a channel parental controls lock (Ask mode). Its guide is neither read nor asked
 * until the PIN lets it play; the guide shows then, when the placeholder makes way.
 */
function useZapData(ref: ItemRef | undefined, now: number, locked = false): ZapData {
  const key = ref ? itemKey(ref) : null;
  const [data, setData] = useState<ZapData>({ key: null });
  // The airing programme ended while the banner is up (a hover across the hour): ask again.
  const airing = data.key === key ? data.guide?.now : undefined;
  const ended = !!airing && ms(airing.end) <= now;
  useEffect(() => {
    if (!ref || !key) return;
    let stale = false;
    const info = peekChannelInfo(ref);
    const guide = locked ? null : ended ? undefined : peekNowNext(ref);
    setData({ key, info, guide, locked });
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
  }, [key, ended, locked]);
  if (data.key === key && !!data.locked === locked) return data;
  return ref ? { key, info: peekChannelInfo(ref), guide: locked ? null : peekNowNext(ref) } : { key };
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

/**
 * The channel's logo: the guide's logo, else the item's own picture, each through the image
 * cache (C3) and then its original URL once; the TV icon when none loads.
 */
function Logo({ urls, sourceId, compact, chip = false }: { urls: readonly (string | undefined)[]; sourceId: string; compact: boolean; chip?: boolean }) {
  const logo = useImageChain(urls.map(safeImageUrl), sourceId);
  const box = chip ? 'size-6 rounded-[3px]' : compact ? 'size-9 rounded-sm' : 'size-14 rounded-md @max-md:size-10';
  if (!logo.url) {
    return (
      <span
        data-testid="zap-logo-fallback"
        className={cn('player-on-glass-muted flex shrink-0 items-center justify-center bg-white/8 ring-1 ring-white/10', box)}
        aria-hidden
      >
        <Tv className={chip ? 'size-3.5' : compact ? 'size-4' : 'size-6'} />
      </span>
    );
  }
  return (
    <img
      src={logo.url}
      alt=""
      aria-hidden
      draggable={false}
      data-testid="zap-logo"
      className={cn('shrink-0 bg-white/8 object-contain ring-1 ring-white/10', chip ? 'p-0.5' : 'p-1', box)}
      onError={logo.onError}
    />
  );
}

/** In place of the logo for a locked channel: a lock on the logo's tile, nothing of the channel's own. */
function LockTile({ compact, chip = false }: { compact: boolean; chip?: boolean }) {
  const box = chip ? 'size-6 rounded-[3px]' : compact ? 'size-9 rounded-sm' : 'size-14 rounded-md @max-md:size-10';
  return (
    <span
      data-testid="zap-lock"
      className={cn('player-on-glass-muted flex shrink-0 items-center justify-center bg-white/8 ring-1 ring-white/10', box)}
      aria-hidden
    >
      <Lock className={chip ? 'size-3.5' : compact ? 'size-4' : 'size-6'} />
    </span>
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

function GuideRows({ guide, now, compact, locked = false }: { guide: EpgNowNext | null | undefined; now: number; compact: boolean; locked?: boolean }) {
  const { t, i18n } = useTranslation('player');
  const lang = i18n.language;
  if (locked) {
    return (
      <p data-testid="zap-locked" className={cn('player-on-glass-muted flex items-center gap-1.5 text-sm', compact ? 'mt-1' : 'mt-2')}>
        <Lock aria-hidden className="size-3.5 shrink-0" />
        {t('zapLocked')}
      </p>
    );
  }
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

  // Labels in a column of their own, as wide as the longest one in the language. A narrow
  // banner (a phone) drops the times column so the titles keep the room; the bar still says
  // how far in, and the minutes left stay for screen readers (out of the grid flow).
  return (
    <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-sm @max-md:grid-cols-[auto_minmax(0,1fr)]">
      {current && (
        <>
          <span className="player-on-glass-muted text-xs font-medium">{t('zapNow')}</span>
          <span data-testid="zap-now" className="truncate" title={current.title}>
            {current.title}
          </span>
          <span className="player-on-glass-muted text-xs tabular-nums @max-md:hidden">
            {formatClock(ms(current.start), lang)}–{formatClock(ms(current.end), lang)}
          </span>
          <span className="sr-only">, {t('zapMinutesLeft', { minutes: minutesLeft })}</span>
          <Progress share={airedShare(current, now)} className="col-[2/-1] mb-1 self-center" />
        </>
      )}
      {upcoming && (
        <>
          <span className="player-on-glass-muted text-xs font-medium">{t('zapNext')}</span>
          <span data-testid="zap-next" className="player-on-glass-muted truncate" title={upcoming.title}>
            {upcoming.title}
          </span>
          <span className="player-on-glass-muted text-xs tabular-nums @max-md:hidden">{formatClock(ms(upcoming.start), lang)}</span>
        </>
      )}
    </div>
  );
}

/** The zap readout (number and name, top corner) says what the banner says: drop it while it is up. */
function useDropZapReadout(shown: boolean, title: string | undefined): void {
  const showing = useZapBanner((s) => s.showing);
  useEffect(() => {
    if (!shown) return;
    const osd = useMediaStore.getState().osd;
    if (osd && title && (osd.primary === title || osd.secondary === title)) useMediaStore.setState({ osd: undefined });
  }, [shown, showing, title]);
}

/**
 * The small player's banner: one line of number, name and what airs now, with how far in as a
 * hairline along its bottom edge. Small enough to leave the picture visible.
 */
function ZapChip({
  number,
  title,
  guide,
  now,
  logo,
  locked = false,
}: {
  number: number | undefined;
  title: string;
  guide: EpgNowNext | null | undefined;
  now: number;
  logo: ReactNode;
  locked?: boolean;
}) {
  const { t } = useTranslation('player');
  const { current } = airingPair(guide, now);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {logo}
        {number !== undefined && (
          <span data-testid="zap-number" className="shrink-0 font-numeric text-base leading-none text-white tabular-nums dark:text-accent-hover">
            {number}
          </span>
        )}
        <span data-testid="zap-title" className="max-w-[60%] shrink-0 truncate font-display text-sm leading-tight" title={title}>
          {title}
        </span>
        {locked ? (
          <span data-testid="zap-locked" className="player-on-glass-muted min-w-0 flex-1 truncate text-xs">
            {t('zapLocked')}
          </span>
        ) : guide === undefined ? (
          <span data-testid="zap-guide-loading" aria-hidden className="h-2.5 w-16 shrink self-center rounded-sm bg-white/10 motion-safe:animate-pulse" />
        ) : (
          current && (
            <span data-testid="zap-now" className="player-on-glass-muted min-w-0 flex-1 truncate text-xs" title={current.title}>
              {current.title}
            </span>
          )
        )}
      </div>
      {current && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10" aria-hidden>
          <div data-testid="zap-progress" className="h-full bg-accent" style={{ width: `${Math.round(airedShare(current, now) * 1000) / 10}%` }} />
        </div>
      )}
    </>
  );
}

/**
 * The tuner's info banner (C5): logo, number, name, and what airs now (with how far in) and
 * next. Up for 5 s on every live channel change and while the channel title is hovered; see
 * `zapBanner.ts`. Over embedded mpv it is cut out of the native video (`data-mpv-overlay`).
 * The caller places it (`className`: position and insets); `compact` is the two-line version
 * for picture-in-picture, `chip` the one-line version for a small player (`useSmallPlayer`). The mini player
 * shows `ZapHeaderLine` in its header instead.
 */
export function ZapBanner({ compact = false, chip = false, className }: { compact?: boolean; chip?: boolean; className?: string }) {
  const { t } = useTranslation('player');
  const shown = useZapBannerShown();
  const showing = useZapBanner((s) => s.showing);
  const source = usePlayerStore((s) => s.source);
  const now = useClock(shown);
  const ref = shown ? source?.ref : undefined;
  const locked = isLockedZap(source);
  const { info, guide } = useZapData(ref, now, locked);
  // Hidden while hovered (the stream failed, the setting went off): no leave comes, so `shown` releases it.
  const hover = useZapHover(shown);
  useDropZapReadout(shown, source?.title);

  if (!shown || !source || !ref) return null;
  const number = info?.number;
  const logos = [info?.logoUrl, source.posterUrl];

  if (chip) {
    return (
      <div
        key={showing}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={t('zapBannerLabel')}
        data-testid="zap-banner"
        data-variant="chip"
        data-zap-banner=""
        data-mpv-overlay=""
        data-mpv-reserved=""
        className={cn(
          'player-glass player-glass-edge glass-blur pointer-events-auto absolute z-[12] overflow-hidden rounded-lg border px-2.5 py-1.5 motion-safe:animate-pop-in',
          className,
        )}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <ZapChip
          number={number}
          title={source.title}
          guide={guide}
          now={now}
          locked={locked}
          logo={locked ? <LockTile compact chip /> : <Logo urls={logos} sourceId={ref.sourceId} compact chip />}
        />
      </div>
    );
  }

  return (
    <div
      key={showing}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={t('zapBannerLabel')}
      data-testid="zap-banner"
      // The surfaces' readout (OSD) moves below this while it shares the readout's column.
      data-zap-banner=""
      data-mpv-overlay=""
      data-mpv-reserved=""
      className={cn(
        'player-glass player-glass-edge glass-blur pointer-events-auto absolute z-[12] border motion-safe:animate-pop-in',
        // Full: a size container, so the guide rows can fit a phone-width banner.
        compact ? 'rounded-md px-2.5 py-2' : '@container w-[min(30rem,calc(100%-1.5rem))] rounded-lg p-3 sm:p-3.5',
        className,
      )}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className={cn('flex min-w-0 items-start', compact ? 'gap-2' : 'gap-3')}>
        {locked ? <LockTile compact={compact} /> : <Logo urls={logos} sourceId={ref.sourceId} compact={compact} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {number !== undefined && (
              // The tuner digit: the dial's accent on the dark themes, glass white on the light one.
              <span
                data-testid="zap-number"
                className={cn(
                  'shrink-0 font-numeric leading-none text-white tabular-nums dark:text-accent-hover',
                  compact ? 'text-lg' : 'text-3xl @max-md:text-2xl',
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
          <GuideRows guide={guide} now={now} compact={compact} locked={locked} />
        </div>
      </div>
    </div>
  );
}

/**
 * The mini player's header while the zap banner is up: the channel number and what airs now
 * beside the name it already shows, instead of a banner over its small picture.
 */
export function ZapHeaderLine({ title }: { title: string }) {
  const { t } = useTranslation('player');
  const shown = useZapBannerShown();
  const source = usePlayerStore((s) => s.source);
  const now = useClock(shown);
  const ref = shown ? source?.ref : undefined;
  const locked = shown && isLockedZap(source);
  const { info, guide } = useZapData(ref, now, locked);
  useDropZapReadout(shown, source?.title);
  const { current } = airingPair(guide, now);
  const number = shown ? info?.number : undefined;
  return (
    <span data-testid="mini-zap-line" className="flex min-w-0 flex-1 items-baseline gap-1.5">
      {number !== undefined && (
        <span data-testid="zap-number" className="shrink-0 font-numeric text-sm leading-none text-accent tabular-nums motion-safe:animate-fade-in">
          {number}
        </span>
      )}
      <span className={cn('min-w-0 truncate', shown && current && 'max-w-[60%] shrink-0')} title={title}>
        {title}
      </span>
      {locked && (
        <span data-testid="zap-locked" className="flex shrink-0 self-center text-fg-muted motion-safe:animate-fade-in">
          <Lock aria-hidden className="size-3.5" />
          <span className="sr-only">{t('zapLocked')}</span>
        </span>
      )}
      {shown && current && (
        <span data-testid="zap-now" className="min-w-0 flex-1 truncate text-xs font-normal text-fg-muted motion-safe:animate-fade-in" title={current.title}>
          {current.title}
        </span>
      )}
    </span>
  );
}
