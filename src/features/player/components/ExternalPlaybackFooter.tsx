import { ExternalLink, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Settings } from '@/api/types';

import { cn } from '../cn';
import { bindExternalEvents, stopExternalPlayback } from '../external';
import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';

const PLAYER_NAMES = { mpv: 'MPV', vlc: 'VLC' } as const;

/**
 * A slim footer while MPV or VLC plays outside the app: what is playing and how to stop it.
 * Rendered once by the shell layout; hidden when no external player runs.
 */
export function ExternalPlaybackFooter({ className }: { className?: string }) {
  const { t } = useTranslation('player');
  const runs = useMediaStore((s) => s.externalRuns);
  const mode = usePlayerStore((s) => s.mode);
  const status = usePlayerStore((s) => s.status);
  const pending = usePlayerStore((s) => (s.mode === 'external' ? s.source : undefined));
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  // `showExternalBar` (default true) lets the user hide this footer entirely.
  const settings = usePlayerSettings() as (Settings & { showExternalBar?: boolean }) | null;

  useEffect(() => bindExternalEvents(), []);

  const latest = runs[runs.length - 1];
  // Before the started event arrives, show the launch from the store.
  const shown = latest ?? (mode === 'external' && pending && status !== 'error' ? { player: null, title: pending.title, startedAt: 0 } : undefined);
  if (settings?.showExternalBar === false) return null;
  if (!shown || (latest && dismissed === latest.startedAt)) return null;
  const name = shown.player ? PLAYER_NAMES[shown.player] : 'MPV';

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 border-t border-edge bg-surface-2 px-4 py-2 text-sm text-fg motion-safe:animate-fade-in',
        className,
      )}
    >
      <ExternalLink className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="shrink-0 text-fg-muted">{t('externalPlaying', { player: name })}</span>
      <span className="min-w-0 truncate font-medium" title={shown.title}>
        {shown.title}
      </span>
      {runs.length > 1 && <span className="shrink-0 rounded-sm bg-surface-3 px-1.5 text-xs text-fg-muted tabular-nums">{runs.length}</span>}
      <span className="ms-auto hidden shrink-0 text-xs text-fg-subtle md:inline">{t('externalStopHint', { player: name })}</span>
      <button
        type="button"
        onClick={() => {
          setStopping(true);
          void stopExternalPlayback().finally(() => setStopping(false));
        }}
        disabled={stopping}
        aria-busy={stopping || undefined}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-edge px-2.5 text-xs font-medium text-fg hover:bg-hover disabled:opacity-50"
      >
        <Square className="size-3 fill-current" aria-hidden />
        {t('externalStop', { player: name })}
      </button>
      {latest && (
        <button
          type="button"
          aria-label={t('dismiss')}
          title={t('dismiss')}
          onClick={() => setDismissed(latest.startedAt)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
