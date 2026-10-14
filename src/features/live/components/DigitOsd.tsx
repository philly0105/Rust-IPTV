import { useTranslation } from 'react-i18next';

export type ZapFeedback = { kind: 'typing'; digits: string } | { kind: 'found'; number: number; name: string } | { kind: 'missing'; number: number };

/** On-screen channel number: what you typed, then what it tuned to. */
export function DigitOsd({ state }: { state: ZapFeedback | null }) {
  const { t } = useTranslation('live');
  if (!state) return null;
  return (
    <div
      role="status"
      aria-live="assertive"
      data-testid="digit-osd"
      className="pointer-events-none absolute top-4 end-4 z-30 flex min-w-24 flex-col items-end rounded-lg bg-black/75 px-4 py-2 text-white shadow-2 backdrop-blur-sm"
    >
      {state.kind === 'typing' ? (
        <>
          <span className="font-mono text-4xl leading-none font-semibold tabular-nums tracking-wider">
            {state.digits}
            <span className="motion-safe:animate-pulse">_</span>
          </span>
          <span className="mt-1 text-[calc(11rem/15)] text-white/70">{t('channelNumber')}</span>
        </>
      ) : state.kind === 'found' ? (
        <>
          <span className="font-mono text-4xl leading-none font-semibold tabular-nums">{state.number}</span>
          <span className="mt-1 max-w-56 truncate text-sm">{state.name}</span>
        </>
      ) : (
        <>
          <span className="font-mono text-4xl leading-none font-semibold text-white/60 tabular-nums line-through">{state.number}</span>
          <span className="mt-1 text-sm">{t('noChannelNumber', { number: state.number })}</span>
        </>
      )}
    </div>
  );
}
