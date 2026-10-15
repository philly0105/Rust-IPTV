import { Camera } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../cn';
import { blockReasonKey, explainBlock, screenshotBlock, takeScreenshot } from '../screenshot';
import { usePlayerStore } from '../store';

/**
 * The camera button (C6). In the control bar it sits with the other round controls; on the
 * external player's stage (`stage`) it is a bordered square like the stage's own buttons.
 *
 * Where there is no picture to take (radio, an external player) it stays in place but is
 * `aria-disabled`, so it remains focusable: the tooltip and the screen reader description say
 * why, and pressing it says so again instead of doing nothing.
 */
export function ScreenshotButton({ stage = false }: { stage?: boolean }) {
  const { t } = useTranslation('player');
  const block = usePlayerStore((s) => screenshotBlock(s));
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const label = t('screenshot');
  const reason = block && block !== 'idle' ? t(blockReasonKey(block)) : undefined;

  const press = (): void => {
    if (block) {
      explainBlock(block);
      return;
    }
    if (busy) return;
    setBusy(true);
    void takeScreenshot().finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        data-ctl="screenshot"
        data-testid="screenshot-button"
        aria-label={label}
        title={reason ? `${label}: ${reason}` : `${label} (S)`}
        aria-keyshortcuts={reason ? undefined : 'S'}
        aria-disabled={reason ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        aria-busy={busy || undefined}
        onClick={press}
        className={cn(
          'inline-flex shrink-0 items-center justify-center motion-safe:transition-colors',
          stage
            ? 'size-9 rounded-md border border-white/25 text-white hover:bg-white/10 [&_svg]:size-4'
            : 'size-10 rounded-full text-white/90 hover:bg-white/12 hover:text-white [&_svg]:size-5',
          (reason || busy) && 'opacity-40',
          reason && 'cursor-not-allowed',
        )}
      >
        <Camera aria-hidden className={cn(busy && 'motion-safe:animate-pulse')} />
      </button>
      {reason && (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </>
  );
}
