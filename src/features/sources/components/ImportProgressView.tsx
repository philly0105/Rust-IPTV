import { useTranslation } from 'react-i18next';

import type { ImportPhase } from '@/api/types';

import { ProgressBar } from '@/ui';
import { formatCount } from '../lib/format';
import { progressFraction, type ProgressEntry } from '../lib/progress';
import { redactText } from '../lib/redact';

const PHASE_KEY: Record<ImportPhase, string> = {
  fetching: 'phaseFetching',
  parsing: 'phaseParsing',
  saving: 'phaseSaving',
  done: 'phaseDone',
  error: 'phaseError',
};

/** Phase, counts, and a bar for one import. `entry` undefined = waiting for the first event. */
export function ImportProgressView({ entry, compact }: { entry: ProgressEntry | undefined; compact?: boolean }) {
  const { t, i18n } = useTranslation('sources');
  const phase: ImportPhase = entry?.phase ?? 'fetching';
  const fraction = entry ? progressFraction(entry) : undefined;
  const label = t(PHASE_KEY[phase]);
  const counts =
    entry && entry.done > 0
      ? entry.total
        ? t('progressOfTotal', { done: formatCount(entry.done, i18n.language), total: formatCount(entry.total, i18n.language) })
        : t('progressItems', { done: formatCount(entry.done, i18n.language) })
      : null;

  return (
    <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'} data-testid="import-progress" data-phase={phase}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        {/* Only the phase is live: counts tick many times a second on a big import and would flood a screen reader. */}
        <span aria-live="polite" className={phase === 'error' ? 'text-danger' : 'text-fg'} data-testid="import-progress-phase">
          {label}
        </span>
        {counts ? <span className="font-display tabular-nums text-fg-muted">{counts}</span> : null}
      </div>
      <ProgressBar value={(fraction ?? 0) * 100} indeterminate={fraction === undefined} max={100} label={label} />
      {entry?.message && !compact ? (
        <p className="truncate text-xs text-fg-subtle" title={redactText(entry.message)}>
          {redactText(entry.message)}
        </p>
      ) : null}
    </div>
  );
}
