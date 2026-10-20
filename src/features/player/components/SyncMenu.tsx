import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';
import { adjustDelay, DELAY_STEP_MS, formatDelay, resetDelay, useSyncStore, type DelayKind } from '../sync';

/** Why a delay cannot be changed here, or null when it can. */
export function useDelayBlocker(kind: DelayKind): string | null {
  const { t } = useTranslation('player');
  const mode = usePlayerStore((s) => s.mode);
  const hasText = useMediaStore((s) => s.tracks.text.length > 0);
  if (kind === 'audio' && mode !== 'embedded-mpv') return t('syncAudioNeedsMpv');
  if (kind === 'sub' && !hasText) return t('syncNoSubtitles');
  return null;
}

/** Summary for the menu row that opens the Sync view: empty while both delays are zero. */
export function useSyncSummary(): string | undefined {
  const { t } = useTranslation('player');
  const changed = useSyncStore((s) => s.audioMs !== 0 || s.subMs !== 0);
  return changed ? t('syncAdjusted') : undefined;
}

const STEP_BUTTON =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-white hover:bg-white/12 disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4';

/**
 * One delay: its name and value, then earlier / later by one step and reset. Unsupported
 * delays keep their row, disabled, with the reason under it and in the tooltip.
 */
function DelayRow({ kind }: { kind: DelayKind }) {
  const { t, i18n } = useTranslation('player');
  const ms = useSyncStore((s) => (kind === 'audio' ? s.audioMs : s.subMs));
  const blocked = useDelayBlocker(kind);
  const label = kind === 'audio' ? t('syncAudio') : t('syncSubtitles');
  const disabled = blocked !== null;
  const step = DELAY_STEP_MS;
  const laterRef = useRef<HTMLButtonElement>(null);
  return (
    <div role="group" aria-label={label} title={blocked ?? undefined} data-testid={`sync-${kind}`} className="rounded-sm px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate text-sm', disabled ? 'text-white/50' : 'text-white')}>{label}</span>
        <Tooltip content={t('syncEarlier', { ms: step })} tone="glass" describe={false}>
          <button
            type="button"
            role="menuitem"
            aria-label={t('syncEarlier', { ms: step })}
            disabled={disabled}
            onClick={() => adjustDelay(kind, -1)}
            className={STEP_BUTTON}
          >
            <Minus aria-hidden />
          </button>
        </Tooltip>
        <output
          aria-live="polite"
          className={cn(
            'w-20 text-center font-mono text-xs tabular-nums',
            disabled ? 'text-white/40' : ms === 0 ? 'text-white/80' : 'text-accent-hover',
          )}
        >
          {formatDelay(ms, i18n.language)}
        </output>
        <Tooltip content={t('syncLater', { ms: step })} tone="glass" describe={false}>
          <button
            ref={laterRef}
            type="button"
            role="menuitem"
            aria-label={t('syncLater', { ms: step })}
            disabled={disabled}
            onClick={() => adjustDelay(kind, 1)}
            className={STEP_BUTTON}
          >
            <Plus aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content={t('syncReset')} tone="glass" describe={false}>
          <button
            type="button"
            role="menuitem"
            aria-label={`${label}: ${t('syncReset')}`}
            disabled={disabled || ms === 0}
            onClick={() => {
              resetDelay(kind);
              // Reset disables itself at zero: keep keyboard focus in the row.
              laterRef.current?.focus();
            }}
            className={STEP_BUTTON}
          >
            <RotateCcw aria-hidden />
          </button>
        </Tooltip>
      </div>
      {blocked && <p className="player-on-glass-muted mt-0.5 text-xs">{blocked}</p>}
    </div>
  );
}

/** The Sync view of the settings and context menus. Stepping keeps the menu open. */
export function SyncRows() {
  return (
    <>
      <DelayRow kind="sub" />
      <DelayRow kind="audio" />
    </>
  );
}
