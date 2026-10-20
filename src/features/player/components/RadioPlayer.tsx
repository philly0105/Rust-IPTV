import { Pause, Play, Radio, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useImageChain } from '@/ui/image';
import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { usePlayerStore, zap } from '../store';
import { ScreenshotButton } from './lazyParts';
import { useNarrow } from './useNarrow';

/** Below this height (CSS px) the radio stage lays out in two rows instead of a column. */
const SHORT_STAGE_PX = 420;

export interface RadioPlayerProps {
  /**
   * 'stage' fills a player slot; 'bar' is a compact strip (mini dock, sidebars); 'thumb' is the
   * station's art alone, the thumbnail of a phone's mini player bar, which holds the controls.
   */
  variant?: 'stage' | 'bar' | 'thumb';
  className?: string;
}

/** The round icon buttons beside play: the control bar's (Controls CtlButton), 44 px under a coarse pointer. */
const RADIO_BUTTON =
  'inline-flex shrink-0 items-center justify-center rounded-full text-on-glass hover:bg-white/12 active:bg-white/20 motion-safe:transition-colors pointer-coarse:size-11';

/** Signal meter: five bars that breathe while audio plays (static under reduced motion). */
function SignalMeter({ active }: { active: boolean }) {
  return (
    <span className="flex h-4 items-end gap-[3px]" aria-hidden>
      {[0.45, 0.8, 0.6, 1, 0.7].map((h, i) => (
        <span
          key={i}
          className={cn('w-[3px] origin-bottom rounded-full bg-accent', active && 'player-radio-bar')}
          style={{ height: `${h * 100}%`, animationDelay: `${i * 0.13}s` }}
        />
      ))}
    </span>
  );
}

/**
 * Compact audio UI for radio: artwork, title, play/pause, previous/next station, volume.
 * Presentational: the audio element lives in the player dock, so this can render anywhere.
 */
export function RadioPlayer({ variant = 'stage', className }: RadioPlayerProps) {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const waiting = useMediaStore((s) => s.waiting);
  // Station art through the image cache (C3), then its own URL once, then the radio icon.
  const art = useImageChain([safeImageUrl(source?.posterUrl)], source?.ref?.sourceId);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  // A short stage (a phone's, above the station list) has no height for the column: the art and
  // the name side by side, the controls under them.
  const shortStage = useNarrow(root, Number.POSITIVE_INFINITY, SHORT_STAGE_PX) && variant === 'stage';
  if (!source) return null;

  if (variant === 'thumb') {
    return (
      <div className={cn('flex h-full w-full items-center justify-center bg-white/5 text-on-glass-muted', className)}>
        {art.url ? <img src={art.url} alt="" className="h-full w-full object-contain p-1" onError={art.onError} /> : <Radio className="size-5" aria-hidden />}
      </div>
    );
  }

  const store = usePlayerStore.getState();
  const playing = status === 'playing';
  const shown = muted ? 0 : volume;
  const VolIcon = shown === 0 ? VolumeX : shown < 0.5 ? Volume1 : Volume2;
  const canZap = !!source.ref;
  const stage = variant === 'stage';
  /** The column's own rows on a tall stage (no box); two rows (art with name, controls with volume) on a short one. */
  const row = shortStage ? 'flex w-full max-w-md items-center gap-4' : 'contents';

  return (
    <section
      ref={setRoot}
      aria-label={t('radio')}
      data-layout={shortStage ? 'rows' : undefined}
      className={cn(
        'player-chrome flex items-center',
        stage
          ? cn(
              // The station's glow over the stage's dark (PlayerSurface): the glass accent, which every theme keeps bright.
              'h-full w-full flex-col justify-center bg-[radial-gradient(ellipse_at_center,color-mix(in_srgb,var(--color-glass-accent)_14%,transparent),transparent_65%)]',
              shortStage ? 'gap-4 px-4 py-3' : 'gap-6 p-6',
            )
          : 'player-stage-dark gap-3 px-3 py-2',
        className,
      )}
    >
      <div className={row}>
        <div
          className={cn(
            'relative shrink-0 overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10',
            shortStage ? 'size-20' : stage ? 'size-[clamp(96px,22vh,200px)]' : 'size-12',
          )}
        >
          {art.url ? (
            <img src={art.url} alt="" className="h-full w-full object-contain p-1" onError={art.onError} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-on-glass-muted">
              <Radio className={stage && !shortStage ? 'size-12' : 'size-6'} aria-hidden />
            </div>
          )}
        </div>

        <div className={cn('min-w-0', stage && !shortStage ? 'max-w-full text-center' : 'flex-1')}>
          <div className={cn('flex items-center gap-2', stage && !shortStage && 'justify-center')}>
            <SignalMeter active={playing && !waiting} />
            <span className="text-caption text-on-glass-muted">{waiting && status !== 'paused' ? t('buffering') : t('radio')}</span>
          </div>
          <p
            dir="auto"
            className={cn('truncate', shortStage ? 'mt-1 text-title-sm' : stage ? 'mt-2 text-title' : 'text-body-sm font-medium')}
            title={source.title}
          >
            {source.title}
          </p>
          {source.subtitle && stage && (
            <p dir="auto" className="mt-0.5 truncate text-body-sm text-on-glass-muted">
              {source.subtitle}
            </p>
          )}
        </div>
      </div>

      <div className={row}>
        <div className={cn('flex shrink-0 items-center', stage && !shortStage ? 'gap-3' : 'gap-1')}>
          {canZap && (
            <Tooltip content={t('previousStation')} tone="glass" describe={false}>
              <button
                type="button"
                aria-label={t('previousStation')}
                onClick={() => void zap('up').catch(() => undefined)}
                className={cn(RADIO_BUTTON, 'size-10')}
              >
                <SkipBack className="size-5" />
              </button>
            </Tooltip>
          )}
          <Tooltip content={playing ? t('pause') : t('play')} tone="glass" describe={false}>
            <button
              type="button"
              aria-label={playing ? t('pause') : t('play')}
              onClick={() => store.togglePlay()}
              className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg hover:bg-accent-solid-hover active:bg-accent-solid-pressed motion-safe:transition-colors',
                stage && !shortStage ? 'size-14' : stage ? 'size-12' : 'size-10 pointer-coarse:size-11',
              )}
            >
              {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
            </button>
          </Tooltip>
          {canZap && (
            <Tooltip content={t('nextStation')} tone="glass" describe={false}>
              <button
                type="button"
                aria-label={t('nextStation')}
                onClick={() => void zap('down').catch(() => undefined)}
                className={cn(RADIO_BUTTON, 'size-10')}
              >
                <SkipForward className="size-5" />
              </button>
            </Tooltip>
          )}
        </div>

        <div className={cn('flex items-center gap-1', shortStage ? 'min-w-0 flex-1' : stage ? 'w-64 max-w-full' : 'w-32')}>
          <Tooltip content={muted ? t('unmute') : t('mute')} tone="glass" describe={false}>
            <button
              type="button"
              aria-label={muted ? t('unmute') : t('mute')}
              onClick={() => store.toggleMute()}
              className={cn(RADIO_BUTTON, 'size-9')}
            >
              <VolIcon className="size-5" />
            </button>
          </Tooltip>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(shown * 100)}
            aria-label={t('volume')}
            aria-valuetext={t('volumePercent', { percent: Math.round(shown * 100) })}
            onChange={(e) => store.setVolume(Number(e.target.value) / 100)}
            onKeyDown={(e) => e.stopPropagation()}
            className="player-range min-w-0 flex-1"
            style={{ ['--fill' as string]: `${Math.round(shown * 100)}%` }}
          />
          {/*
            Screenshot (C6): in place, like the video bar's camera, but disabled with its reason (radio
            has no picture). The strip has no room for it, as the video player's mini bar has none.
          */}
          {stage && <ScreenshotButton />}
        </div>
      </div>
    </section>
  );
}
