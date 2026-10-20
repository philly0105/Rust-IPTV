import { AlertTriangle, ExternalLink, RotateCcw, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { stopExternalPlayback } from '../external';

import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';
import { glassButton } from './glassButton';
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
      className="player-chrome player-stage-dark absolute inset-0 flex flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-8 text-center"
    >
      <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-full bg-white/8 ring-1 ring-white/15">
        {failed ? <AlertTriangle className="size-6 text-warning" /> : <ExternalLink className="size-6" />}
      </span>
      <div className="flex max-w-[min(36rem,100%)] flex-col gap-1" role={failed ? 'alert' : 'status'}>
        <p className="text-body-sm text-on-glass-muted">
          {failed ? t('externalFailed') : launching ? t('externalOpening', { player: name }) : t('externalPlaying', { player: name })}
        </p>
        <h2 dir="auto" className="truncate text-title" title={source.title}>
          {source.title}
        </h2>
        {source.subtitle && (
          <p dir="auto" className="truncate text-body-sm text-on-glass-muted">
            {source.subtitle}
          </p>
        )}
        {failed && error && <p className="mt-1 text-body-sm break-words text-on-glass-muted">{error}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={reopen} disabled={launching} className={glassButton('primary')}>
          <RotateCcw aria-hidden />
          {failed ? t('retry') : t('externalReopen', { player: name })}
        </button>
        <button type="button" onClick={stop} disabled={stopping} aria-busy={stopping || undefined} className={glassButton('secondary')}>
          <Square className="fill-current" aria-hidden />
          {t('stop')}
        </button>
        {/* Screenshot (C6): disabled here, with the reason (the external player has its own key). */}
        <ScreenshotButton stage />
      </div>
      {!failed && <p className="max-w-md text-caption text-on-glass-muted">{t('externalStopHint', { player: name })}</p>}
    </div>
  );
}
