import { useTranslation } from 'react-i18next';

export type ZapFeedback = { kind: 'typing'; digits: string } | { kind: 'missing'; number: number };

/**
 * On-screen channel number: what you typed, or that no channel has it. A number that tunes says
 * nothing more here, since the zap banner names the channel. While it shows, the page puts away
 * a zap banner left from the last zap (see LivePage), so the two never cover each other.
 */
export function DigitOsd({ state }: { state: ZapFeedback | null }) {
  const { t } = useTranslation('live');
  if (!state) return null;
  return (
    <div
      role="status"
      aria-live="assertive"
      data-testid="digit-osd"
      // The zap banner's look (LG-15): glass, and the number in the dial's amber, so the readout and
      // the banner that follows it read as one control.
      className="pointer-events-none absolute top-4 end-4 z-30 flex min-w-24 flex-col items-end rounded-xl border border-glass-border bg-glass-strong px-4 py-2.5 text-on-glass shadow-2 glass-blur"
    >
      {state.kind === 'typing' ? (
        <>
          <span className="font-numeric text-5xl leading-none tabular-nums tracking-wide text-glass-accent">
            {state.digits}
            <span className="motion-safe:animate-pulse">_</span>
          </span>
          <span className="mt-1 text-caption text-on-glass-muted">{t('channelNumber')}</span>
        </>
      ) : (
        <>
          <span className="font-numeric text-5xl leading-none text-on-glass-muted tabular-nums line-through">{state.number}</span>
          <span className="mt-1 text-body-sm">{t('noChannelNumber', { number: state.number })}</span>
        </>
      )}
    </div>
  );
}
