import { useTranslation } from 'react-i18next';

import { cn } from '../cn';
import { useReconnectStore } from '../reconnect';

/** The words for the current recovery step, or null while nothing is recovering. */
export function useReconnectLabel(): string | null {
  const { t } = useTranslation('player');
  const phase = useReconnectStore((s) => s.phase);
  const attempt = useReconnectStore((s) => s.attempt);
  const max = useReconnectStore((s) => s.max);
  if (phase === 'retrying') return t('reconnectingAttempt', { attempt, max });
  if (phase === 'switching') return t('switchingSource');
  return null;
}

/**
 * Built-in player: a quiet pill under the loading dial (which spins already) while smart reconnect or failover works,
 * in place of the error overlay.
 */
export function ReconnectNotice({ compact }: { compact: boolean }) {
  const label = useReconnectLabel();
  if (!label) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex justify-center pt-12">
      <p
        role="status"
        aria-live="polite"
        data-testid="reconnect-notice"
        className={cn(
          'player-glass-strong inline-flex max-w-[90%] items-center gap-2 rounded-full border px-3 py-1',
          compact ? 'text-caption' : 'text-body-sm',
        )}
      >
        <span className="truncate">{label}</span>
      </p>
    </div>
  );
}
