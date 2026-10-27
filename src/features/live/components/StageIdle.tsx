import { Lock, Play, Radio, Tv } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type Channel, type EpgNowNext, type ItemRef, type RecentEntry } from '@/api/types';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';

import { displayChannelName } from '../lib/channelName';
import { isValidProgram, minutesLeft, programProgress, programWhen, shiftNowNext } from '../lib/epgTime';
import { ChannelLogo } from './ChannelLogo';

export interface StageIdleProps {
  kind: 'live' | 'radio';
  /** The channel last watched here, offered with Resume; none: a short prompt. */
  last?: { channel: Channel; nowNext?: EpgNowNext };
  /**
   * `last` is the list's cursor row, not the channel last watched: once the user moves through
   * the list the card follows the cursor (as the ribbon under it does), says so, and offers Play.
   */
  highlighted?: boolean;
  /**
   * The channel asks for the PIN (parental Ask mode, no session unlock): what is on it waits for
   * the PIN, as on its row and the ribbon. The page resolves it from its locks, so the card hides
   * the programme again when an unlock runs out.
   */
  locked?: boolean;
  now: number;
  stripPrefix?: boolean;
  epgOffsetMinutes?: number;
  onResume?(channel: Channel): void;
  /** The idle prompt's own hint, when it differs from Live's ("Pick a channel, or type its number"). */
  hint?: string;
  /** Radio: more stations played lately, as tiles under Resume (from md up, where the stage is tall). */
  recent?: readonly RecentEntry[];
  onPlayRef?(ref: ItemRef): void;
}

/**
 * The card's lines that go as the stage gets shorter (from md up; a phone's idle bar lays out on
 * its own). The full card (logo, caption, name, Resume, hint) is about 14 rem tall; without the
 * hint about 12.5 rem; without the logo too about 7.5 rem, and the caption goes last.
 */
const LOW_STAGE = 'md:[@container_(max-height:15rem)]:hidden';
const SHORT_STAGE = 'md:[@container_(max-height:12.5rem)]:hidden';
const TINY_STAGE = 'md:[@container_(max-height:8rem)]:hidden';

/**
 * What the stage shows while nothing plays (CB-AUTOPLAY-LAST), one design for Live, a custom
 * list and Radio: the last channel's logo, its name, what is on it now and a Resume button, over a dark
 * glow in the channel's own hue. Nothing is started by itself. With no channel to offer, a
 * prompt to pick one.
 *
 * The stage is dark in every theme, so from md up the text takes the glass colours; on a phone
 * the idle stage is a slim bar on the theme's surface above the list, with theme colours.
 *
 * From md up a TV channel's programme stays out of the card: the guide ribbon's Now card right
 * under the stage describes the same channel with the same programme, time left and progress.
 * Radio has no ribbon, so its card keeps them. The card is a size container and sheds lines as the
 * stage gets shorter (a laptop's or tablet's stage column is 170 to 230 px tall): the hint first,
 * then the logo, so the name and Resume are never cut off.
 */
export function StageIdle({ kind, last, highlighted = false, locked = false, now, stripPrefix, epgOffsetMinutes = 0, onResume, hint, recent, onPlayRef }: StageIdleProps) {
  const { t } = useTranslation('live');
  const channel = last?.channel;
  const name = channel ? displayChannelName(channel.name, stripPrefix) : '';
  const shifted = channel && !locked ? shiftNowNext(last?.nowNext, epgOffsetMinutes) : undefined;
  const cur = shifted?.now && isValidProgram(shifted.now) && programWhen(shifted.now, now) === 'now' ? shifted.now : undefined;
  // A soft glow in the hue of the tile above it: the logo's own colour once it has loaded (the
  // monogram's for a channel without one), slate while it loads, for a logo with no colour to
  // read, and without a channel. Low saturation, so it tints the stage without washing it.
  const channelKey = channel ? itemKey(channel.ref) : '';
  const [tileHue, setTileHue] = useState<{ key: string; hue: number | null }>({ key: '', hue: null });
  const onHue = useCallback((hue: number | null) => setTileHue((prev) => (prev.key === channelKey && prev.hue === hue ? prev : { key: channelKey, hue })), [channelKey]);
  const hue = channel && tileHue.key === channelKey ? tileHue.hue : null;
  const glow = hue === null ? 'hsl(220 20% 18% / 0.85)' : `hsl(${hue} 25% 20% / 0.85)`;
  const Icon = kind === 'radio' ? Radio : Tv;

  return (
    <div data-testid="stage-idle" className="absolute inset-0 flex items-center justify-center overflow-hidden [container-type:size] max-md:justify-start max-md:px-4">
      {/* The glow is the dark stage's; a phone's idle bar sits on the theme's surface instead. */}
      <span
        aria-hidden
        className="absolute inset-0 max-md:hidden"
        data-testid="stage-idle-glow"
        data-hue={hue ?? undefined}
        style={{ backgroundImage: `radial-gradient(120% 90% at 50% 18%, ${glow}, transparent 68%)` }}
      />
      {channel ? (
        <div className="relative flex max-w-md min-w-0 flex-col items-center gap-3 px-6 text-center max-md:w-full max-md:max-w-none max-md:flex-row max-md:gap-3 max-md:px-0 max-md:text-start">
          <ChannelLogo src={channel.logoUrl} name={name} size={64} sourceId={channel.ref.sourceId} className={cn('shadow-2 max-md:hidden', SHORT_STAGE)} onHue={onHue} />
          <ChannelLogo src={channel.logoUrl} name={name} size={32} sourceId={channel.ref.sourceId} className="md:hidden" />
          <div className="flex min-w-0 flex-col items-center gap-0.5 max-md:flex-1 max-md:items-start">
            <p className={cn('text-caption text-on-glass-muted max-md:hidden', TINY_STAGE)} data-testid="stage-idle-caption">
              {t(highlighted ? 'highlightedChannel' : kind === 'radio' ? 'lastStation' : 'lastWatched')}
            </p>
            <p dir="auto" className="max-w-full truncate text-title-sm text-on-glass max-md:text-body-sm max-md:font-medium max-md:text-fg">
              {name}
            </p>
            {locked ? (
              <p className="mt-1 inline-flex items-center gap-1.5 text-body-sm text-on-glass-muted max-md:mt-0 max-md:text-caption max-md:text-fg-muted" data-testid="stage-idle-locked">
                <Lock aria-hidden className="size-3.5 shrink-0" />
                {t('locked')}
              </p>
            ) : cur ? (
              <div className={cn('mt-1 flex w-80 max-w-full flex-col gap-1.5 max-md:mt-0 max-md:w-full max-md:gap-1', kind === 'live' && 'md:hidden')}>
                <p dir="auto" className="truncate text-body-sm text-on-glass-muted max-md:text-caption max-md:text-fg-muted" data-testid="stage-idle-now">
                  {t('idleNowOn', { title: cur.title, left: t('minutesLeft', { count: minutesLeft(cur, now) }) })}
                </p>
                <span aria-hidden className="relative h-[3px] w-full overflow-hidden rounded-full bg-on-glass/15 max-md:hidden">
                  <span className="absolute inset-y-0 start-0 rounded-full bg-on-glass/60" style={{ width: `${programProgress(cur, now) * 100}%` }} />
                </span>
              </div>
            ) : null}
          </div>
          <Button
            variant="primary"
            size="md"
            icon={<Play size={16} className="fill-current" />}
            className="mt-2 max-w-full max-md:mt-0 max-md:shrink-0"
            onClick={() => onResume?.(channel)}
            data-testid="stage-resume"
          >
            <span className="truncate max-md:hidden">{t(highlighted ? 'playChannel' : 'resumeChannel', { name })}</span>
            <span className="md:hidden">{t(highlighted ? 'play' : 'resume')}</span>
          </Button>
          <p className={cn('mt-1 text-caption text-on-glass-muted max-md:hidden', LOW_STAGE)} data-testid="stage-idle-hint">
            {hint ?? t(kind === 'radio' ? 'radioIdleHint' : 'stageIdleHint')}
          </p>
          {recent && recent.length > 0 && onPlayRef ? (
            <StationShelf
              heading={t('recentStations')}
              items={recent.map((e) => ({ ref: e.ref, name: displayChannelName(e.snapshot.title, stripPrefix), logo: e.snapshot.posterUrl }))}
              onPlay={onPlayRef}
            />
          ) : null}
        </div>
      ) : (
        <div className="relative flex min-w-0 flex-col items-center gap-2 px-6 text-center max-md:flex-row max-md:gap-3 max-md:px-0 max-md:text-start">
          <span
            aria-hidden
            className={cn(
              'inline-flex size-14 items-center justify-center rounded-full bg-on-glass/8 text-on-glass-muted ring-1 ring-on-glass/10',
              'max-md:size-9 max-md:bg-surface-3 max-md:text-fg-muted max-md:ring-0',
            )}
          >
            <Icon size={24} className="max-md:size-[18px]" />
          </span>
          <div className="flex min-w-0 flex-col gap-1 max-md:gap-0">
            <p className="text-body font-medium text-on-glass max-md:truncate max-md:text-body-sm max-md:text-fg">
              {t(kind === 'radio' ? 'radioIdle' : 'stageIdle')}
            </p>
            <p className="text-caption text-on-glass-muted max-md:truncate max-md:text-fg-subtle">
              {hint ?? t(kind === 'radio' ? 'radioIdleHint' : 'stageIdleHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Station tiles under the idle stage's prompt (Radio, from md up): logo and name, one press plays. */
function StationShelf({ heading, items, onPlay }: { heading: string; items: { ref: ItemRef; name: string; logo?: string }[]; onPlay(ref: ItemRef): void }) {
  const { t } = useTranslation('live');
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-6 flex w-full max-w-xl flex-col items-center gap-3 max-md:hidden" data-testid="stage-recent">
      <h2 id={id} className="text-caption font-medium text-on-glass-muted">
        {heading}
      </h2>
      <ul className="flex flex-wrap items-start justify-center gap-2">
        {items.map((it) => (
          <li key={itemKey(it.ref)}>
            <button
              type="button"
              onClick={() => onPlay(it.ref)}
              aria-label={t('playNamed', { name: it.name })}
              className="flex w-24 flex-col items-center gap-1.5 rounded-lg p-2 text-on-glass outline-none hover:bg-on-glass/8 active:bg-on-glass/12 focus-visible:ring-2 focus-visible:ring-focus"
            >
              <ChannelLogo src={it.logo} name={it.name} size={48} sourceId={it.ref.sourceId} />
              {/* Two lines before the ellipsis: "Tidewater Jazz Radio" reads whole, not "Tidewater ...". */}
              <span dir="auto" className="line-clamp-2 w-full text-center text-caption break-words" title={it.name}>
                {it.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
