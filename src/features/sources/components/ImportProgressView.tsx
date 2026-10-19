import { clsx } from 'clsx';
import { CircleSlash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ImportPhase, ImportSaveStep, SourceKind } from '@/api/types';
import { numberFormat } from '@/lib/intl';

import { Button, ProgressBar } from '@/ui';
import { importSummaryKey } from '../lib/errors';
import { formatFileSize } from '../lib/files';
import { formatCount } from '../lib/format';
import { isRunningPhase, progressFraction, type ProgressEntry } from '../lib/progress';
import { redactText } from '../lib/redact';
import { splitErrorText } from '../lib/sourceError';

const PHASE_KEY: Record<ImportPhase, string> = {
  connecting: 'phaseStarting',
  fetching: 'phaseFetching',
  parsing: 'phaseParsing',
  saving: 'phaseSaving',
  done: 'phaseDone',
  error: 'phaseError',
  cancelled: 'phaseCancelled',
};

/**
 * The two long steps at the end of `saving` (L3-import-ui-3): the old catalog going, then the
 * indexes and counts being rebuilt. Neither has a count worth showing, so the bar is indeterminate.
 * A core that does not send `step` keeps the plain "Saving N of N".
 */
const SAVE_STEP_KEY: Readonly<Record<ImportSaveStep, string>> = {
  replacing: 'phaseReplacing',
  indexing: 'phaseIndexing',
};

/**
 * The core's fixed progress messages, shown translated: the Xtream content type being fetched or
 * read, the Stalker stage, and `unchanged` (a refresh found nothing new). Null hides one the phase
 * label already says. Any other text (a warning, an error) is shown as the core sent it.
 */
const STEP_KEY: Readonly<Record<string, string | null>> = {
  account: 'progressStepAccount',
  live: 'progressStepLive',
  movies: 'progressStepMovies',
  series: 'progressStepSeries',
  'Connecting to the portal': 'progressStepPortal',
  'Loading channel categories': 'progressStepChannelGroups',
  'Loading channels': 'progressStepChannels',
  'Loading radio': 'progressStepRadio',
  'Loading movie and series categories': 'progressStepVodGroups',
  'Saving the catalog': null,
  unchanged: 'progressStepUnchanged',
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
  /** Server the import contacts, for "Connecting to <host>" until the first progress arrives. */
  host?: string;
  /** When the run started (ms), for the seconds shown while waiting; defaults to when this view mounted. */
  startedAt?: number;
}

/**
 * True until the run reports something to show: no event yet, a `connecting` event (sent by
 * cores that announce the start), or a download still waiting for its first byte.
 */
export function isWaitingForData(entry: ProgressEntry | undefined): boolean {
  if (!entry) return true;
  const phase: string = entry.phase;
  return phase === 'connecting' || (phase === 'fetching' && !(entry.done > 0) && !entry.total);
}

/**
 * Seconds without an answer after which "Connecting to <host>" turns into "Still trying to reach
 * <host>" (L3-import-ui-4): the core gives up on an unreachable host after 3 s.
 */
export const STILL_TRYING_S = 2;

/** Whole seconds since `since`, ticking once a second while `on`. */
function useElapsedSeconds(since: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

function formatSeconds(n: number, lang: string): string {
  try {
    return numberFormat(lang, { style: 'unit', unit: 'second', unitDisplay: 'narrow' }).format(n);
  } catch {
    return `${n}s`;
  }
}

/** Phase, counts, and a bar for one import, with Cancel while it runs and a designed cancelled state. */
export function ImportProgressView({ entry, compact, onCancel, cancelling, cancelledNote, kind, host, startedAt }: ImportProgressViewProps) {
  const { t, i18n } = useTranslation('sources');
  const phase: ImportPhase = entry?.phase ?? 'fetching';
  const running = isRunningPhase(phase);
  // Before the first progress (a slow server, a long first byte) the view says what it waits on and counts the seconds.
  const waiting = running && isWaitingForData(entry);
  const [mountedAt] = useState(() => Date.now());
  const elapsed = useElapsedSeconds(startedAt ?? mountedAt, waiting);
  const saveStep = phase === 'saving' && entry?.step && Object.hasOwn(SAVE_STEP_KEY, entry.step) ? SAVE_STEP_KEY[entry.step] : undefined;
  const label =
    cancelling && running
      ? t('phaseCancelling')
      : waiting
        ? host
          ? t(elapsed >= STILL_TRYING_S ? 'phaseStillTrying' : 'phaseConnectingTo', { host })
          : t('phaseStarting')
        : saveStep
          ? t(saveStep)
          : t(PHASE_KEY[phase] ?? 'phaseFetching');

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
  const counts = waiting
    ? elapsed > 0
      ? formatSeconds(elapsed, i18n.language)
      : null
    : entry && entry.done > 0 && phase !== 'error' && !saveStep
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
  const message = entry?.message;
  const step = message !== undefined && Object.hasOwn(STEP_KEY, message) ? STEP_KEY[message] : undefined;
  // A known step in the user's language; otherwise the error's plain part only (a technical detail
  // after the core's separator stays out of view).
  const detail = step !== undefined ? (step ? t(step) : '') : message ? redactText(splitErrorText(message).plain) : '';
  const errorSummary = phase === 'error' && (entry?.code || entry?.message) ? t(importSummaryKey(entry.message, entry.code)) : null;

  return (
    <div
      className={compact ? 'flex flex-col gap-1' : 'flex flex-col gap-2'}
      data-testid="import-progress"
      data-phase={phase}
      data-waiting={waiting || undefined}
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        {/* Only the phase is live: counts tick many times a second on a big import and would flood a screen reader. */}
        <span aria-live="polite" className={clsx('min-w-0 truncate', phase === 'error' ? 'text-danger' : 'text-fg')} title={label} data-testid="import-progress-phase">
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {counts ? (
            <span className="font-display tabular-nums text-fg-muted" data-testid={waiting ? 'import-progress-elapsed' : 'import-progress-counts'}>
              {counts}
            </span>
          ) : null}
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
      ) : detail && !compact ? (
        // The retry line replaces the core's English "Retrying the download ..." message.
        <p className="truncate text-xs text-fg-subtle" title={detail} data-testid="import-progress-detail">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
