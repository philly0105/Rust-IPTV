import { CircleSlash } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ImportPhase, SourceKind } from '@/api/types';

import { Button, ProgressBar } from '@/ui';
import { importSummaryKey } from '../lib/errors';
import { formatFileSize } from '../lib/files';
import { formatCount } from '../lib/format';
import { isRunningPhase, progressFraction, type ProgressEntry } from '../lib/progress';
import { redactText } from '../lib/redact';
import { splitErrorText } from '../lib/sourceError';

const PHASE_KEY: Record<ImportPhase, string> = {
  fetching: 'phaseFetching',
  parsing: 'phaseParsing',
  saving: 'phaseSaving',
  done: 'phaseDone',
  error: 'phaseError',
  cancelled: 'phaseCancelled',
};

export interface ImportProgressViewProps {
  /** Latest event; undefined = waiting for the first one. */
  entry: ProgressEntry | undefined;
  compact?: boolean;
  /** Shows a Cancel button while the import runs (C8). */
  onCancel?: () => void;
  /** The cancel request is out: the button reads "Cancelling..." and is disabled. */
  cancelling?: boolean;
  /** Line under "Import cancelled"; defaults to "the previous channels are kept". */
  cancelledNote?: string;
  /** Kind of the source importing. An M3U download reports bytes, not items, while it fetches. */
  kind?: SourceKind;
}

/** Phase, counts, and a bar for one import, with Cancel while it runs and a designed cancelled state. */
export function ImportProgressView({ entry, compact, onCancel, cancelling, cancelledNote, kind }: ImportProgressViewProps) {
  const { t, i18n } = useTranslation('sources');
  const phase: ImportPhase = entry?.phase ?? 'fetching';
  const running = isRunningPhase(phase);
  const label = cancelling && running ? t('phaseCancelling') : t(PHASE_KEY[phase]);

  if (phase === 'cancelled') {
    return (
      <div className="flex items-start gap-2.5 text-sm" data-testid="import-progress" data-phase={phase}>
        <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span aria-live="polite" className="font-medium text-fg" data-testid="import-progress-phase">
            {label}
          </span>
          <span className="text-fg-muted" data-testid="import-cancelled-note">
            {cancelledNote ?? t('cancelledKeptCatalog')}
          </span>
        </p>
      </div>
    );
  }

  const fraction = entry ? progressFraction(entry) : undefined;
  const counts =
    entry && entry.done > 0 && phase !== 'error'
      ? kind === 'm3u' && phase === 'fetching'
        ? t('progressBytes', { size: formatFileSize(entry.done, i18n.language) })
        : entry.total
        ? t('progressOfTotal', { done: formatCount(entry.done, i18n.language), total: formatCount(entry.total, i18n.language) })
        : t('progressItems', { done: formatCount(entry.done, i18n.language) })
      : null;
  const retry =
    phase === 'fetching' && entry?.attempt !== undefined && entry.attempts !== undefined
      ? t('progressRetry', { attempt: formatCount(entry.attempt, i18n.language), attempts: formatCount(entry.attempts, i18n.language) })
      : null;
  // The error's plain part only; a technical detail after the core's separator stays out of view.
  const rawMessage = entry?.message ? redactText(splitErrorText(entry.message).plain) : '';
  const errorSummary = phase === 'error' && (entry?.code || entry?.message) ? t(importSummaryKey(entry.message, entry.code)) : null;

  return (
    <div className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'} data-testid="import-progress" data-phase={phase}>
      <div className="flex items-center justify-between gap-3 text-sm">
        {/* Only the phase is live: counts tick many times a second on a big import and would flood a screen reader. */}
        <span aria-live="polite" className={phase === 'error' ? 'text-danger' : 'text-fg'} data-testid="import-progress-phase">
          {label}
        </span>
        <span className="flex items-center gap-2">
          {counts ? <span className="font-display tabular-nums text-fg-muted">{counts}</span> : null}
          {onCancel && running ? (
            <Button
              size="sm"
              variant="ghost"
              // `loading`, not `disabled`: a disabled button drops focus to <body>, outside the dialog's Escape handler.
              loading={cancelling}
              onClick={onCancel}
              data-testid="import-cancel"
            >
              {cancelling ? t('cancellingImport') : t('cancelImport')}
            </Button>
          ) : null}
        </span>
      </div>
      <ProgressBar value={(fraction ?? 0) * 100} indeterminate={fraction === undefined && running} max={100} label={label} />
      {errorSummary && !compact ? <p className="text-xs text-fg">{errorSummary}</p> : null}
      {retry ? (
        <p className="text-xs text-fg-muted" data-testid="import-retry">
          {retry}
        </p>
      ) : rawMessage && !compact ? (
        // The retry line replaces the core's English "Retrying the download ..." message.
        <p className="truncate text-xs text-fg-subtle" title={rawMessage}>
          {rawMessage}
        </p>
      ) : null}
    </div>
  );
}
