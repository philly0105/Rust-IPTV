import { ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../cn';
import { bindExternalEvents } from '../external';
import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';

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

  useEffect(() => bindExternalEvents(), []);

  const latest = runs[runs.length - 1];
  // Before the started event arrives, show the launch from the store.
  const shown = latest ?? (mode === 'external' && pending && status !== 'error' ? { player: null, title: pending.title, startedAt: 0 } : undefined);
  if (!shown || (latest && dismissed === latest.startedAt)) return null;
  const name = shown.player ? PLAYER_NAMES[shown.player] : 'MPV';

  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 border-t border-border bg-surface-2 px-4 py-2 text-sm text-fg motion-safe:animate-fade-in',
        className,
      )}
    >
      <ExternalLink className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="shrink-0 text-fg-muted">{t('externalPlaying', { player: name })}</span>
      <span className="min-w-0 truncate font-medium" title={shown.title}>
        {shown.title}
      </span>
      {runs.length > 1 && <span className="shrink-0 rounded-sm bg-surface-3 px-1.5 text-xs text-fg-muted tabular-nums">{runs.length}</span>}
      <span className="ml-auto hidden shrink-0 text-xs text-fg-subtle md:inline">{t('externalStopHint', { player: name })}</span>
      {latest && (
        <button
          type="button"
          aria-label={t('dismiss')}
          title={t('dismiss')}
          onClick={() => setDismissed(latest.startedAt)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-3 hover:text-fg"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
