import { AlertTriangle, ExternalLink, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { stopExternalPlayback } from '../external';

import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';
import { ScreenshotButton } from './lazyParts';

export const PLAYER_NAMES = { mpv: 'MPV', vlc: 'VLC' } as const;

/**
 * What a page's player stage shows while the current item plays in MPV or VLC outside the app:
 * the title, which player has it, and Stop / Reopen. Replaces the page's "nothing playing" state.
 */
export function ExternalStage() {
  const { t } = useTranslation('player');
  const source = usePlayerStore((s) => s.source);
  const status = usePlayerStore((s) => s.status);
  const error = usePlayerStore((s) => s.error);
  const runs = useMediaStore((s) => s.externalRuns);
  const settings = usePlayerSettings();
  const [stopping, setStopping] = useState(false);
  if (!source) return null;

  const latest = runs[runs.length - 1];
  const player = latest?.player ?? (settings?.player === 'vlc' ? 'vlc' : 'mpv');
  const name = PLAYER_NAMES[player];
  const failed = status === 'error';
  const launching = status === 'loading';

  const stop = (): void => {
    setStopping(true);
    void stopExternalPlayback().finally(() => setStopping(false));
  };

  const reopen = (): void => {
    const s = usePlayerStore.getState();
    if (s.source) void s.play(s.source, { mode: 'external', queue: s.queue });
  };

  return (
    <div
      data-testid="external-stage"
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#070b12] px-6 text-center text-white"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-white/8 ring-1 ring-white/15">
        {failed ? <AlertTriangle className="size-5 text-warning" aria-hidden /> : <ExternalLink className="size-5 text-accent" aria-hidden />}
      </span>
      <div className="max-w-[min(36rem,100%)]" role={failed ? 'alert' : 'status'}>
        <p className="text-sm text-white/70">
          {failed ? t('externalFailed') : launching ? t('externalOpening', { player: name }) : t('externalPlaying', { player: name })}
        </p>
        <h2 className="mt-1 truncate font-display text-xl" title={source.title}>
          {source.title}
        </h2>
        {source.subtitle && <p className="truncate text-sm text-white/60">{source.subtitle}</p>}
        {failed && error && <p className="mt-2 text-sm break-words text-white/70">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={reopen}
          disabled={launching}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
        >
          <RotateCcw className="size-4" aria-hidden />
          {failed ? t('retry') : t('externalReopen', { player: name })}
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          aria-busy={stopping || undefined}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/25 px-3 py-1.5 text-sm hover:bg-white/10 disabled:opacity-50"
        >
          <Square className="size-3.5 fill-current" aria-hidden />
          {t('stop')}
        </button>
        {/* Screenshot (C6): disabled here, with the reason (the external player has its own key). */}
        <ScreenshotButton stage />
      </div>
      {!failed && <p className="text-xs text-white/50">{t('externalStopHint', { player: name })}</p>}
    </div>
  );
}
