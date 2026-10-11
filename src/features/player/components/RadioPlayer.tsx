import { Pause, Play, Radio, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../cn';
import { safeImageUrl } from '../format';
import { useMediaStore } from '../media';
import { usePlayerStore, zap } from '../store';

export interface RadioPlayerProps {
  /** 'stage' fills a player slot; 'bar' is a compact strip (mini dock, sidebars). */
  variant?: 'stage' | 'bar';
  className?: string;
}

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
  const [artFailed, setArtFailed] = useState<string | null>(null);
  if (!source) return null;

  const store = usePlayerStore.getState();
  const playing = status === 'playing';
  const art = safeImageUrl(source.posterUrl);
  const showArt = art && artFailed !== art;
  const shown = muted ? 0 : volume;
  const VolIcon = shown === 0 ? VolumeX : shown < 0.5 ? Volume1 : Volume2;
  const canZap = !!source.ref;
  const stage = variant === 'stage';

  return (
    <section
      aria-label={t('radio')}
      className={cn(
        'flex items-center text-white',
        stage
          ? 'h-full w-full flex-col justify-center gap-6 bg-[radial-gradient(ellipse_at_center,rgb(245_181_68/0.14),transparent_65%)] p-6'
          : 'gap-3 bg-[#070b12] px-3 py-2',
        className,
      )}
    >
      <div
        className={cn(
          'relative shrink-0 overflow-hidden rounded-lg bg-white/5 ring-1 ring-white/10',
          stage ? 'size-[clamp(96px,22vh,200px)]' : 'size-12',
        )}
      >
        {showArt ? (
          <img src={art} alt="" className="h-full w-full object-contain p-1" onError={() => setArtFailed(art)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-accent">
            <Radio className={stage ? 'size-12' : 'size-6'} aria-hidden />
          </div>
        )}
      </div>

      <div className={cn('min-w-0', stage ? 'max-w-full text-center' : 'flex-1')}>
        <div className={cn('flex items-center gap-2', stage && 'justify-center')}>
          <SignalMeter active={playing && !waiting} />
          <span className="text-xs text-white/70">{waiting && status !== 'paused' ? t('buffering') : t('radio')}</span>
        </div>
        <p className={cn('truncate font-display', stage ? 'mt-2 text-2xl' : 'text-sm')} title={source.title}>
          {source.title}
        </p>
        {source.subtitle && stage && <p className="truncate text-sm text-white/70">{source.subtitle}</p>}
      </div>

      <div className={cn('flex items-center', stage ? 'gap-3' : 'gap-1')}>
        {canZap && (
          <button
            type="button"
            aria-label={t('previousStation')}
            title={t('previousStation')}
            onClick={() => void zap('up').catch(() => undefined)}
            className="inline-flex size-10 items-center justify-center rounded-full text-white/85 hover:bg-white/10 hover:text-white"
          >
            <SkipBack className="size-5" />
          </button>
        )}
        <button
          type="button"
          aria-label={playing ? t('pause') : t('play')}
          title={playing ? t('pause') : t('play')}
          onClick={() => store.togglePlay()}
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-accent text-accent-fg hover:bg-accent-hover',
            stage ? 'size-14' : 'size-10',
          )}
        >
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
        </button>
        {canZap && (
          <button
            type="button"
            aria-label={t('nextStation')}
            title={t('nextStation')}
            onClick={() => void zap('down').catch(() => undefined)}
            className="inline-flex size-10 items-center justify-center rounded-full text-white/85 hover:bg-white/10 hover:text-white"
          >
            <SkipForward className="size-5" />
          </button>
        )}
      </div>

      <div className={cn('flex items-center gap-1', stage ? 'w-56' : 'w-32')}>
        <button
          type="button"
          aria-label={muted ? t('unmute') : t('mute')}
          title={muted ? t('unmute') : t('mute')}
          onClick={() => store.toggleMute()}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white/85 hover:bg-white/10"
        >
          <VolIcon className="size-5" />
        </button>
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
      </div>
    </section>
  );
}
