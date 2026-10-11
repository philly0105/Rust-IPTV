import { CalendarClock, CalendarX2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ProgressBar } from '../_shim';
import type { SourceGuideSummary } from '../lib/epgRefresh';
import { formatCount } from '../lib/format';
import { redactText } from '../lib/redact';

/** One compact line for a source's guide (EPG) load: queued, loading with a count, loaded, or failed. */
export function GuideProgressView({ guide }: { guide: SourceGuideSummary }) {
  const { t, i18n } = useTranslation('sources');
  const programs = guide.programs > 0 ? t('guidePrograms', { count: guide.programs, value: formatCount(guide.programs, i18n.language) }) : null;
  const failed = !guide.active && guide.error !== undefined && !guide.done;
  const label = guide.active ? (guide.phase === 'queued' ? t('guideQueued') : t('guideLoading')) : failed ? t('guideFailed') : t('guideDone');

  return (
    <div className="flex flex-col gap-1" data-testid="guide-progress" data-phase={guide.phase}>
      <div className="flex items-baseline justify-between gap-3 text-sm" aria-live="polite">
        <span className={failed ? 'flex min-w-0 items-center gap-1.5 text-danger' : 'flex min-w-0 items-center gap-1.5 text-fg'}>
          {failed ? <CalendarX2 aria-hidden className="size-4 shrink-0" /> : <CalendarClock aria-hidden className="size-4 shrink-0 text-accent" />}
          <span className="truncate">{label}</span>
        </span>
        {programs ? <span className="shrink-0 font-display tabular-nums text-fg-muted">{programs}</span> : null}
      </div>
      {guide.active ? <ProgressBar value={undefined} max={100} label={label} /> : null}
      {failed && guide.error ? <p className="truncate text-xs text-fg-subtle" title={redactText(guide.error)}>{redactText(guide.error)}</p> : null}
    </div>
  );
}
