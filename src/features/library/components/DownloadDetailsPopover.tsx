/**
 * A running download's speed breakdown: the total, what holds it back in one plain sentence,
 * where its bytes come from (each source, then each connection) and the transfer's recent notes.
 * Opened from the row's Speed details button; a dialog from sm up and a bottom sheet on a phone
 * (the kit Dialog), so Escape closes it and focus goes back to the button.
 *
 * Numbers come from `downloads.stats` events (about once a second). Until one arrives it shows the
 * row's own `stats`, and asks `downloads.stats` every couple of seconds while no event is fresh.
 */

import { Gauge } from 'lucide-react';
import { useEffect, useId, useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import type { ConnectionStat, Download, Source, SourceStat, TransferStats } from '@/api/types';
import { cn } from '@/ui/cn';
import { TINT_THEME, tintVars } from '@/ui/tint';

import { Dialog } from '../deps';
import { formatBytes, formatDuration, formatSpeed } from '../lib/format';
import { STATS_STALE_MS, statsStore, useLiveProgress, useLiveStats } from '../lib/progress';
import { downloadNames } from '../lib/queue';
import { countsText, limitText, limitingText, noteText, type NameOf } from '../lib/transferText';
import { SourceMonogram } from './bits';

/** How often the dialog asks `downloads.stats` while no event has come in. */
export const STATS_POLL_MS = 2_000;

export interface DownloadDetailsPopoverProps {
  /** The row as the list has it now (it may finish while the dialog is open). */
  download: Download;
  sources: ReadonlyMap<string, Source>;
  onClose: () => void;
}

/**
 * While open and running: asks the command now and every STATS_POLL_MS while no event is fresh,
 * and feeds the answer to the stats store, so the dialog reads one place whichever way it came.
 */
function useStatsFallback(id: number, running: boolean): void {
  useEffect(() => {
    if (!running) return;
    let alive = true;
    let inFlight = false;
    const ask = () => {
      const live = statsStore.get(id);
      if (inFlight || (live && Date.now() - live.at < STATS_STALE_MS)) return;
      inFlight = true;
      rpc('downloads.stats', { id })
        .then((s: TransferStats | null) => {
          if (alive && s) statsStore.ingest(s);
        })
        // A transfer that just ended or an older core: the row's own numbers stay.
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    ask();
    const timer = setInterval(ask, STATS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [id, running]);
}

export function DownloadDetailsPopover({ download: d, sources, onClose }: DownloadDetailsPopoverProps) {
  const { t, i18n } = useTranslation('library');
  const lang = i18n.language;
  const running = d.status === 'downloading';
  const progress = useLiveProgress(d);
  const stats = useLiveStats(d);
  useStatsFallback(d.id, running);
  const names = downloadNames(d);
  const ids = useId();

  const nameOf: NameOf = useMemo(() => (id: string) => sources.get(id)?.name ?? t('sourceRemoved'), [sources, t]);
  // The live figure the row shows (smoothed), else the breakdown's own total.
  const total = progress.bytesPerSecond ?? (stats && stats.bytesPerSecond > 0 ? stats.bytesPerSecond : undefined);
  const connections = stats ? Math.max(stats.connections.length, progress.connections ?? 0) : progress.connections;
  const sourceCount = stats ? Math.max(stats.sources.filter((s) => s.connections > 0).length, progress.sources ?? 0) : progress.sources;
  const counts = countsText(t, connections, sourceCount);
  const limiting = stats?.limiting ? limitingText(t, stats.limiting, nameOf, lang) : '';
  const notes = stats?.notes.map((n) => noteText(t, n, nameOf)).filter(Boolean) ?? [];

  let body;
  if (!running) {
    body = <p className="text-body-sm text-fg-muted" data-testid="details-idle">{t('detailsNotRunning')}</p>;
  } else {
    body = (
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-title-sm tabular-nums text-fg" data-testid="details-total">
              {total ? formatSpeed(total, lang) : t('stalled')}
            </span>
            {counts && <span className="text-caption text-fg-muted tabular-nums" data-testid="details-counts">{counts}</span>}
          </p>
          {limiting ? (
            <p className="flex items-start gap-2 text-body-sm text-fg" data-testid="details-limiting">
              <Gauge size={16} aria-hidden className="mt-0.5 shrink-0 text-fg-subtle" />
              <span className="min-w-0 text-pretty">{limiting}</span>
            </p>
          ) : null}
        </div>

        {stats ? (
          <>
            {stats.sources.length > 0 && (
              <section aria-labelledby={`${ids}-sources`} className="flex flex-col gap-2">
                <h3 id={`${ids}-sources`} className="text-body-sm font-semibold text-fg-muted">
                  {t('detailsSources')}
                </h3>
                {stats.sources.length > 1 && <ShareBar sources={stats.sources} nameOf={nameOf} />}
                <ul className="flex flex-col divide-y divide-divider rounded-lg border border-edge" data-testid="details-sources">
                  {stats.sources.map((s) => (
                    <SourceLine key={s.sourceId} stat={s} name={nameOf(s.sourceId)} known={sources.has(s.sourceId)} lang={lang} />
                  ))}
                </ul>
              </section>
            )}
            {stats.connections.length > 0 && (
              <section aria-labelledby={`${ids}-connections`} className="flex flex-col gap-2">
                <h3 id={`${ids}-connections`} className="text-body-sm font-semibold text-fg-muted">
                  {t('detailsConnections')}
                </h3>
                <ul className="flex flex-col divide-y divide-divider rounded-lg border border-edge" data-testid="details-connections">
                  {stats.connections.map((c, i) => (
                    <ConnectionLine key={`${c.sourceId}-${c.host}-${c.address ?? ''}-${i}`} stat={c} index={i} name={nameOf(c.sourceId)} known={sources.has(c.sourceId)} lang={lang} />
                  ))}
                </ul>
              </section>
            )}
            {notes.length > 0 && (
              <section aria-labelledby={`${ids}-notes`} className="flex flex-col gap-1.5">
                <h3 id={`${ids}-notes`} className="text-body-sm font-semibold text-fg-muted">
                  {t('detailsNotes')}
                </h3>
                {/* Newest first: the one the row shows leads. Status, never an error tone. */}
                <ul className="flex flex-col gap-1 text-body-sm text-fg-muted" data-testid="details-notes">
                  {[...notes].reverse().map((text, i) => (
                    <li key={`${i}-${text}`} className="text-pretty">
                      {text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <p className="text-body-sm text-fg-muted" data-testid="details-waiting">
            {t('detailsWaiting')}
          </p>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('detailsTitle')}
      description={names.subtitle ? `${names.title} · ${names.subtitle}` : names.title}
      size="md"
      testId="download-details"
    >
      {body}
    </Dialog>
  );
}

/**
 * Each source's share of the speed as one bar, each part in its source's monogram hue, so the
 * sources below read back to it. Decorative: the list under it gives every figure in words.
 */
function ShareBar({ sources, nameOf }: { sources: readonly SourceStat[]; nameOf: NameOf }) {
  const sum = sources.reduce((n, s) => n + Math.max(0, s.bytesPerSecond), 0);
  if (sum <= 0) return null;
  return (
    <div aria-hidden className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-surface-3" data-testid="details-share">
      {sources
        .filter((s) => s.bytesPerSecond > 0)
        .map((s) => (
          <div
            key={s.sourceId}
            className={cn('h-full min-w-1', TINT_THEME)}
            style={{ ...tintVars(nameOf(s.sourceId)), flexGrow: s.bytesPerSecond, flexBasis: 0 } as CSSProperties}
          />
        ))}
    </div>
  );
}

function Mark({ name, known }: { name: string; known: boolean }) {
  return known ? <SourceMonogram name={name} className="mt-0.5" /> : <span aria-hidden className="mt-0.5 size-4 shrink-0 rounded-xs bg-surface-3" />;
}

function SourceLine({ stat: s, name, known, lang }: { stat: SourceStat; name: string; known: boolean; lang: string }) {
  const { t } = useTranslation('library');
  const speed = formatSpeed(s.bytesPerSecond, lang);
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-testid="details-source" data-source-id={s.sourceId} data-role={s.role}>
      <Mark name={name} known={known} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
          <span dir="auto" className="min-w-0 truncate text-body-sm font-medium text-fg" title={name}>
            {name}
          </span>
          <span className="shrink-0 text-body-sm tabular-nums text-fg">{speed || t('detailsIdleSpeed')}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-caption text-fg-muted">
          <span className="min-w-0">
            {[t(s.role === 'mirror' ? 'detailsRoleMirror' : 'detailsRolePrimary'), t('transferConnections', { count: s.connections }), limitText(t, s)].join(' · ')}
          </span>
          <span className="shrink-0 tabular-nums">{t('detailsServed', { bytes: formatBytes(s.bytes, lang) })}</span>
        </div>
      </div>
    </li>
  );
}

function ConnectionLine({ stat: c, index, name, known, lang }: { stat: ConnectionStat; index: number; name: string; known: boolean; lang: string }) {
  const { t, i18n } = useTranslation('library');
  const speed = formatSpeed(c.bytesPerSecond, lang);
  const age = formatDuration(Math.max(0, c.ageMs) / 1000, { locale: lang, t: (key, vars) => i18n.t(`vod:${key}`, vars) });
  return (
    <li className="flex items-start gap-3 px-3 py-2" data-testid="details-connection">
      <Mark name={name} known={known} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
          <span className="min-w-0 truncate text-body-sm text-fg" title={c.address ? `${c.host} (${c.address})` : c.host}>
            <span className="sr-only">{t('detailsConnectionN', { n: index + 1, name })} </span>
            <span dir="ltr">{c.host}</span>
            {c.address && <span dir="ltr" className="ms-1.5 text-caption text-fg-subtle">{c.address}</span>}
          </span>
          <span className="shrink-0 text-body-sm tabular-nums text-fg">{speed || t('detailsIdleSpeed')}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-caption text-fg-muted">
          <span className="min-w-0 truncate" dir="auto">
            {name}
          </span>
          <span className="shrink-0 tabular-nums">
            {[t('detailsServed', { bytes: formatBytes(c.bytes, lang) }), age ? t('detailsOpenFor', { time: age }) : ''].filter(Boolean).join(' · ')}
          </span>
        </div>
      </div>
    </li>
  );
}
