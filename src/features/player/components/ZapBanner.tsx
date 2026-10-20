import { Lock, Tv } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type EpgNowNext, type ItemRef } from '@/api/types';
import { formatClock, formatTimeRange, ms } from '@/features/live/lib/epgTime';
import { monogramFill, monogramText } from '@/features/live/lib/monogram';
import { useImageChain } from '@/ui/image';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { airedShare, airingPair, fetchNowNext, peekNowNext } from '../nowNext';
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
function useClock(active: boolean, everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);
  return now;
}

/**
 * The channel's logo: the guide's logo, else the item's own picture, each through the image
 * cache (C3) and then its original URL once. When none loads, the channel's monogram, the same
 * tile the channel list and the guide draw (LG-14); the TV icon only for a channel with no name.
 */
function Logo({
  urls,
  sourceId,
  name,
  compact,
  chip = false,
  box: boxClass,
}: {
  urls: readonly (string | undefined)[];
  sourceId: string;
  /** The channel's name, for the monogram. */
  name?: string;
  compact: boolean;
  chip?: boolean;
  /** Size and corner in place of the variant's (the title bar's 40 px tile). */
  box?: string;
}) {
  const logo = useImageChain(urls.map(safeImageUrl), sourceId);
  const box = boxClass ?? (chip ? 'size-6 rounded-xs' : compact ? 'size-9 rounded-sm' : 'size-14 rounded-md @max-md:size-10');
  if (!logo.url && name?.trim()) {
    return (
      <span
        data-testid="zap-logo-fallback"
        data-monogram=""
        className={cn(
          'flex shrink-0 items-center justify-center font-display leading-none font-semibold tracking-tight text-white ring-1 ring-white/10',
          chip ? 'text-2xs' : compact ? 'text-xs' : 'text-title-sm @max-md:text-sm',
          box,
        )}
        style={{ background: monogramFill(name) }}
        aria-hidden
      >
        {monogramText(name)}
      </span>
    );
  }
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
function LockTile({ compact, chip = false, box: boxClass }: { compact: boolean; chip?: boolean; box?: string }) {
  const box = boxClass ?? (chip ? 'size-6 rounded-xs' : compact ? 'size-9 rounded-sm' : 'size-14 rounded-md @max-md:size-10');
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
function Progress({ share, className, testId = 'zap-progress' }: { share: number; className?: string; testId?: string }) {
  return (
    <div className={cn('h-[3px] overflow-hidden rounded-full bg-white/15', className)} aria-hidden>
      <div data-testid={testId} className="h-full rounded-full bg-accent" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
    </div>
  );
}

/** Re-exported for the banner's tests and callers that already import it from here. */
export { airingPair };

function GuideRows({ guide, now, compact, locked = false }: { guide: EpgNowNext | null | undefined; now: number; compact: boolean; locked?: boolean }) {
  const { t, i18n } = useTranslation('player');
  const lang = i18n.language;
  if (locked) {
    return (
      <p data-testid="zap-locked" className={cn('player-on-glass-muted flex items-center gap-1.5 text-body-sm', compact ? 'mt-1' : 'mt-2')}>
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
      <p data-testid="zap-no-guide" className={cn('player-on-glass-muted text-body-sm', compact ? 'mt-1' : 'mt-2')}>
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
        <div className="flex min-w-0 items-baseline gap-2 text-caption">
          <span className="min-w-0 flex-1 truncate" title={shown.title}>
            {shown.title}
          </span>
          <span className="player-on-glass-muted shrink-0 font-numeric tabular-nums">
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
    <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 text-body-sm @max-md:grid-cols-[auto_minmax(0,1fr)]">
      {current && (
        <>
          <span className="player-on-glass-muted text-caption font-medium">{t('zapNow')}</span>
          <span data-testid="zap-now" className="truncate font-medium" title={current.title}>
            {current.title}
          </span>
          <span className="player-on-glass-muted font-numeric text-caption tabular-nums @max-md:hidden">
            {formatTimeRange(ms(current.start), ms(current.end), lang)}
          </span>
          <span className="sr-only">, {t('zapMinutesLeft', { minutes: minutesLeft })}</span>
          <Progress share={airedShare(current, now)} className="col-[2/-1] mb-1 self-center" />
        </>
      )}
      {upcoming && (
        <>
          <span className="player-on-glass-muted text-caption font-medium">{t('zapNext')}</span>
          <span data-testid="zap-next" className="player-on-glass-muted truncate" title={upcoming.title}>
            {upcoming.title}
          </span>
          <span className="player-on-glass-muted font-numeric text-caption tabular-nums @max-md:hidden">{formatClock(ms(upcoming.start), lang)}</span>
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
          <span data-testid="zap-number" className="shrink-0 font-numeric text-body leading-none text-on-glass-muted tabular-nums">
            {number}
          </span>
        )}
        <span data-testid="zap-title" className="max-w-[60%] shrink-0 truncate text-body-sm leading-tight font-medium" title={title}>
          {title}
        </span>
        {locked ? (
          <span data-testid="zap-locked" className="player-on-glass-muted min-w-0 flex-1 truncate text-caption">
            {t('zapLocked')}
          </span>
        ) : guide === undefined ? (
          <span data-testid="zap-guide-loading" aria-hidden className="h-2.5 w-16 shrink self-center rounded-sm bg-white/10 motion-safe:animate-pulse" />
        ) : (
          current && (
            <span data-testid="zap-now" className="player-on-glass-muted min-w-0 flex-1 truncate text-caption" title={current.title}>
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
          logo={locked ? <LockTile compact chip /> : <Logo urls={logos} sourceId={ref.sourceId} name={source.title} compact chip />}
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
        {locked ? <LockTile compact={compact} /> : <Logo urls={logos} sourceId={ref.sourceId} name={source.title} compact={compact} />}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {number !== undefined && (
              // The tuner digit: a quieter partner to the name, as channel numbers are in the lists;
              // the accent stays for the progress under what airs.
              <span
                data-testid="zap-number"
                className={cn('shrink-0 font-numeric leading-none text-on-glass-muted tabular-nums', compact ? 'text-body' : 'text-title @max-md:text-title-sm')}
              >
                {number}
              </span>
            )}
            <span
              data-testid="zap-title"
              className={cn('min-w-0 truncate leading-tight', compact ? 'text-body-sm font-medium' : 'text-title-sm')}
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
    // A size container: a phone's mini player (under 14rem of header) keeps the number and the name
    // and leaves what airs out, rather than cut both down to a few letters.
    <span data-testid="mini-zap-line" className="@container flex min-w-0 flex-1">
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {number !== undefined && (
          <span data-testid="zap-number" className="shrink-0 font-numeric text-body-sm leading-none text-fg-muted tabular-nums motion-safe:animate-fade-in">
            {number}
          </span>
        )}
        <span className={cn('min-w-0 truncate', shown && current && 'max-w-[60%] shrink-0 @max-[14rem]:max-w-none @max-[14rem]:shrink')} title={title}>
          {title}
        </span>
        {locked && (
          <span data-testid="zap-locked" className="flex shrink-0 self-center text-fg-muted motion-safe:animate-fade-in">
            <Lock aria-hidden className="size-3.5" />
            <span className="sr-only">{t('zapLocked')}</span>
          </span>
        )}
        {shown && current && (
          <span
            data-testid="zap-now"
            className="min-w-0 flex-1 truncate text-caption font-normal text-fg-muted motion-safe:animate-fade-in @max-[14rem]:hidden"
            title={current.title}
          >
            {current.title}
          </span>
        )}
      </span>
    </span>
  );
}

/** How often the title bar's programme line moves on (its minutes left, its bar). */
const TITLE_CLOCK_MS = 30_000;

/**
 * The channel's logo in the player's title bar, where a LIVE pill used to repeat the bar's badge
 * (PL-DUPLICATE-CHROME). The banner's own lookup and image cache; the channel's monogram when none loads.
 */
export function TitleLogo({ channel, posterUrl, big = false }: { channel: ItemRef; posterUrl?: string | undefined; big?: boolean }) {
  const source = usePlayerStore((s) => s.source);
  const locked = isLockedZap(source);
  const { info } = useZapData(channel, 0, locked);
  // 40 px beside the title, 56 in fullscreen.
  const box = big ? 'size-14 rounded-lg' : 'size-10 rounded-md';
  if (locked) return <LockTile compact box={box} />;
  return <Logo urls={[info?.logoUrl, posterUrl]} sourceId={channel.sourceId} name={source?.title} compact box={box} />;
}

/**
 * Under the channel's name in the title bar: what airs now, how long it has left and how far in
 * (PL-STALE-PROGRAMME). It follows the guide on a 30 s clock, so an hour on one channel no longer
 * leaves the previous show there. `fallback` (the subtitle the channel was tuned with) shows while
 * the guide is asked, and when it has nothing.
 */
export function LiveProgrammeLine({ channel, fallback }: { channel: ItemRef; fallback?: string | undefined }) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const locked = isLockedZap(source);
  const now = useClock(true, TITLE_CLOCK_MS);
  const { guide } = useZapData(channel, now, locked);
  const { current } = airingPair(guide, now);
  if (!current) {
    return fallback ? (
      <p dir="auto" data-testid="player-subtitle" className="mt-0.5 truncate text-body-sm text-on-glass-muted">
        {fallback}
      </p>
    ) : null;
  }
  const minutesLeft = Math.max(1, Math.ceil((ms(current.end) - now) / 60_000));
  return (
    <div data-testid="player-programme" className="mt-0.5 flex min-w-0 flex-col gap-1">
      <p className="flex min-w-0 items-baseline gap-1.5 text-body-sm text-on-glass-muted">
        <span dir="auto" data-testid="player-subtitle" className="min-w-0 truncate text-on-glass">
          {current.title}
        </span>
        <span aria-hidden>·</span>
        <span className="sr-only">, </span>
        <span className="shrink-0 tabular-nums">{t('zapMinutesLeft', { minutes: minutesLeft })}</span>
      </p>
      <Progress share={airedShare(current, now)} className="w-36 max-w-full" testId="player-programme-progress" />
    </div>
  );
}
