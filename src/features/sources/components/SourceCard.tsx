import { clsx } from 'clsx';
import { CircleAlert, GripVertical, IdCard, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useId, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { AccountStatus, ScheduleEntry } from '@/api/rpc';
import type { Source, SourceKind } from '@/api/types';

import { Badge, Button, IconButton } from '@/ui';
import { baseName } from '../lib/files';
import { absoluteTime, formatCount, relativeTime } from '../lib/format';
import { useSourceGuide } from '../lib/epgRefresh';
import { isRunningPhase, type ProgressEntry } from '../lib/progress';
import { redactText } from '../lib/redact';
import { SOURCE_ERROR_KEYS, classifySourceError, sourceErrorDetail, splitErrorText } from '../lib/sourceError';
import { displayHost } from '../lib/validate';
import { AccountBadges } from './AccountBadges';
import { hasAccountInfo } from './AccountPanel';
import { GuideProgressView } from './GuideProgressView';
import { ImportProgressView } from './ImportProgressView';

export const KIND_MARK: Record<SourceKind, string> = { m3u: 'M3U', xtream: 'XC', stalker: 'STB' };

/** Stat columns of the wide layout, in order. */
const STAT_SLOTS = ['channels', 'radio', 'movies', 'series'] as const;

/** One-line description of where a source comes from. Never shows secrets. */
export function sourceOrigin(s: Source, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (s.kind === 'm3u') {
    if (s.m3u?.origin === 'url') return displayHost(s.m3u.url) ?? t('originUrl');
    if (s.m3u?.origin === 'file') return s.m3u.filePath ? baseName(s.m3u.filePath) : t('originFile');
    return t('originPasted');
  }
  if (s.kind === 'xtream') {
    const host = displayHost(s.xtream?.serverUrl) ?? '';
    return s.xtream?.username ? t('originAccount', { host, user: s.xtream.username }) : host;
  }
  const host = displayHost(s.stalker?.portalUrl) ?? '';
  return s.stalker?.macAddress ? t('originAccount', { host, user: maskMac(s.stalker.macAddress) }) : host;
}

/**
 * A Stalker MAC is the whole login, so the card shows only enough to tell two
 * accounts apart: the vendor prefix and the last byte (`00:1A:79:••:••:56`).
 * Anything that is not a MAC keeps its first and last two characters.
 */
export function maskMac(mac: string): string {
  const parts = mac.trim().split(/[:-]/);
  if (parts.length === 6) return [...parts.slice(0, 3), '••', '••', parts[5]].join(':');
  const v = mac.trim();
  return v.length <= 4 ? '••••' : `${v.slice(0, 2)}••••${v.slice(-2)}`;
}

/** Host of the source's own address, for error messages that do not name one. */
function sourceHost(s: Source): string | undefined {
  if (s.kind === 'm3u') return s.m3u?.origin === 'url' ? displayHost(s.m3u.url) : undefined;
  if (s.kind === 'xtream') return displayHost(s.xtream?.serverUrl);
  return displayHost(s.stalker?.portalUrl);
}

/**
 * The failed-refresh line: a translated message keyed by the error's category,
 * with the core's raw (English, OS-level) text behind a disclosure. Errors the
 * app does not recognise keep the raw text in view, since it is the only detail.
 */
function SourceErrorText({ source }: { source: Source }) {
  const { t } = useTranslation('sources');
  const raw = source.lastError ?? '';
  const info = classifySourceError(raw, source.lastErrorCode);
  // The core may split its text into a plain message and a technical detail (B8's unreadable reply).
  const split = splitErrorText(sourceErrorDetail(raw));
  const plain = redactText(split.plain);
  const detail = redactText(split.detail ?? split.plain);
  // The classified code, for support and the README's "Error code: X" (C10).
  const codeLine = source.lastErrorCode ? (
    <p className="mt-1 font-mono" dir="ltr" data-testid="source-error-code">
      {t('common:errorCode', { code: source.lastErrorCode })}
    </p>
  ) : null;
  if (info.kind === 'unknown') {
    return (
      <div className="min-w-0 flex-1 text-fg">
        <p className="break-words">
          <span className="font-medium">{t('lastRefreshFailed')}</span>{' '}
          <span className="text-fg-muted" data-testid="source-error-plain">
            {plain}
          </span>
        </p>
        {codeLine || split.detail ? (
          <details className="mt-1 text-xs text-fg-subtle">
            <summary className="w-fit cursor-pointer rounded-sm hover:text-fg-muted">{t('technicalDetails')}</summary>
            {split.detail ? (
              <p className="mt-1 font-mono break-words" dir="ltr" data-testid="source-error-detail">
                {detail}
              </p>
            ) : null}
            {codeLine}
          </details>
        ) : null}
      </div>
    );
  }
  const host = info.host ?? sourceHost(source) ?? t('sourceErrorHostFallback');
  // Sign-in advice names what this kind of source signs in with.
  const key = info.kind === 'auth' ? `sourceErrorAuth_${source.kind}` : SOURCE_ERROR_KEYS[info.kind];
  return (
    <div className="min-w-0 flex-1 text-fg">
      <p className="break-words">
        <span className="font-medium">{t('lastRefreshFailed')}</span>{' '}
        <span className="text-fg-muted" data-testid="source-error-message" data-kind={info.kind}>
          {t(key, { host })}
        </span>
      </p>
      <details className="mt-1 text-xs text-fg-subtle">
        <summary className="w-fit cursor-pointer rounded-sm hover:text-fg-muted">{t('technicalDetails')}</summary>
        <p className="mt-1 font-mono break-words" dir="ltr" data-testid="source-error-detail">
          {detail}
        </p>
        {codeLine}
      </details>
    </div>
  );
}

/** Radio stations in the source; 0 when an older core omits `radioCount`. */
export function radioCount(s: Source): number {
  const n: unknown = s.radioCount;
  return typeof n === 'number' && n > 0 ? n : 0;
}

export interface SourceCardProps {
  source: Source;
  index: number;
  total: number;
  progress?: ProgressEntry;
  refreshing: boolean;
  dragging: boolean;
  dropTarget: 'before' | 'after' | null;
  onRefresh: () => void;
  onEdit: () => void;
  /** Opens the subscription details (Xtream and Stalker only). */
  onAccount?: () => void;
  onRemove: () => void;
  /** Stops the running import or refresh (C8). */
  onCancelImport?: () => void;
  /** A cancel request for this source is out. */
  cancelling?: boolean;
  /** False while the list is sorted or filtered: order only changes in the manual view. */
  reorderable?: boolean;
  onMove: (to: number) => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  /** Cached subscription status (Xtream and Stalker). */
  account?: AccountStatus | null;
  /** `accountExpiryWarnDays`; 0 turns the expiring badge off. */
  warnDays?: number;
  /** When the scheduled refresh runs next; absent when the source is not scheduled. */
  schedule?: ScheduleEntry;
}

/**
 * "Next refresh in 4 hours", or "Retrying in 30 minutes" after a failure. A time already
 * passed reads as soon: the scheduler checks every 10 minutes.
 */
function nextRefreshText(entry: ScheduleEntry, lang: string, t: (k: string, o?: Record<string, unknown>) => string, now: number = Date.now()): string | undefined {
  const at = Date.parse(entry.nextRefreshAt);
  if (Number.isNaN(at)) return undefined;
  if (at <= now + 60_000) return t('nextRefreshSoon');
  const when = relativeTime(entry.nextRefreshAt, lang, now);
  return when ? t(entry.retrying ? 'nextRefreshRetry' : 'nextRefreshIn', { when }) : undefined;
}

export function SourceCard(props: SourceCardProps) {
  const { source: s, index, total, progress, refreshing, reorderable = true } = props;
  const { t, i18n } = useTranslation('sources');
  const lang = i18n.language;
  const busy = refreshing || isRunningPhase(progress?.phase);
  // A cancelled run lingers briefly (LINGER_MS) in place of the error strip: the old catalog and its error are unchanged.
  const cancelled = !busy && progress?.phase === 'cancelled';
  const guide = useSourceGuide(s.epg);
  // Names the source for the error strip's buttons: several cards can show "Try again" at once.
  const nameId = useId();

  // `channelCount` is live channels only; radio gets its own stat when the source has any.
  const radio = radioCount(s);
  const live = s.channelCount;
  const stats: { key: string; value: number; label: string }[] = [{ key: 'channels', value: live, label: t('statChannels', { count: live }) }];
  if (radio > 0) stats.push({ key: 'radio', value: radio, label: t('statRadio', { count: radio }) });
  if (s.kind !== 'm3u' || s.movieCount > 0) stats.push({ key: 'movies', value: s.movieCount, label: t('statMovies', { count: s.movieCount }) });
  if (s.kind !== 'm3u' || s.seriesCount > 0) stats.push({ key: 'series', value: s.seriesCount, label: t('statSeries', { count: s.seriesCount }) });
  // Wide layout: one fixed slot per stat, empty when the source has none, so the columns line up across cards.
  const slots = STAT_SLOTS.map((key) => ({ key, stat: stats.find((st) => st.key === key) }));

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Alt+Arrow anywhere on the card, or plain arrows on the grip, move it.
    const onGrip = (e.target as HTMLElement).dataset.grip === 'true';
    if (!reorderable || !(e.altKey || onGrip)) return;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      props.onMove(index - 1);
    } else if (e.key === 'ArrowDown' && index < total - 1) {
      e.preventDefault();
      props.onMove(index + 1);
    } else if (onGrip && e.key === 'Home' && index > 0) {
      e.preventDefault();
      props.onMove(0);
    } else if (onGrip && e.key === 'End' && index < total - 1) {
      e.preventDefault();
      props.onMove(total - 1);
    }
  };

  const refreshed = relativeTime(s.lastRefreshAt, lang);
  const failed = s.lastError ? relativeTime(s.lastErrorAt, lang) : undefined;
  const next = s.autoRefresh && props.schedule && !busy ? nextRefreshText(props.schedule, lang, t) : undefined;

  return (
    <li
      data-testid="source-card"
      data-source-id={s.id}
      onKeyDown={onKeyDown}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      className={clsx(
        'relative rounded-lg border bg-surface shadow-1',
        s.lastError && !busy ? 'border-danger/60' : 'border-border',
        props.dragging && 'opacity-50',
      )}
    >
      {props.dropTarget ? (
        <span
          aria-hidden
          className={clsx('pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-accent', props.dropTarget === 'before' ? '-top-1.5' : '-bottom-1.5')}
        />
      ) : null}
      <div className="flex items-center gap-2 p-3 @2xl:gap-4 @2xl:p-4">
        {reorderable ? (
        <button
          type="button"
          draggable
          data-grip="true"
          onDragStart={props.onDragStart}
          onDragEnd={props.onDragEnd}
          aria-label={t('reorderHandle', { name: s.name, position: index + 1, total })}
          aria-describedby="sources-reorder-help"
          className="flex h-11 w-6 shrink-0 cursor-grab items-center justify-center rounded-sm text-fg-subtle hover:text-fg active:cursor-grabbing"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
        ) : null}

        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 font-display text-sm font-semibold tracking-wide text-accent"
        >
          {KIND_MARK[s.kind]}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/s/${s.id}/live`}
              id={nameId}
              dir="auto"
              className="truncate font-display text-lg font-semibold text-fg hover:text-accent"
              data-testid="source-name"
            >
              {s.name}
            </Link>
            <span className="sr-only">{t(`kindLabel_${s.kind}`)}</span>
            {s.autoRefresh ? <Badge>{t('autoRefreshBadge')}</Badge> : null}
            <AccountBadges status={props.account} warnDays={props.warnDays ?? 0} />
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-fg-muted">
            <span className="truncate" dir="auto">
              {sourceOrigin(s, t)}
            </span>
            {/* With an error and no good refresh yet, the error strip says it all; "Not refreshed yet" beside it reads as a contradiction. */}
            {refreshed || !s.lastError ? (
              <span className="text-fg-subtle" title={absoluteTime(s.lastRefreshAt, lang)} data-testid="source-refreshed">
                {refreshed ? t('refreshedAgo', { when: refreshed }) : t('neverRefreshed')}
              </span>
            ) : null}
            {failed ? (
              <span className="text-danger" title={absoluteTime(s.lastErrorAt, lang)} data-testid="source-failed-at">
                {t('failedAgo', { when: failed })}
              </span>
            ) : null}
            {next ? (
              <span className="text-fg-subtle" title={absoluteTime(props.schedule?.nextRefreshAt, lang)} data-testid="source-next-refresh">
                {next}
              </span>
            ) : null}
          </p>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 @3xl:hidden">
            {stats.map((st) => (
              <div key={st.key} className="flex items-baseline gap-1 text-sm">
                <dt className="sr-only">{st.label}</dt>
                <dd className="flex items-baseline gap-1">
                  <span className="font-display font-semibold tabular-nums text-fg">{formatCount(st.value, lang)}</span>
                  <span aria-hidden className="text-fg-muted">
                    {st.label}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <dl className="hidden shrink-0 gap-4 @3xl:flex">
          {slots.map(({ key, stat }) =>
            stat ? (
              <div key={key} className="flex w-20 flex-col-reverse items-end" data-testid="source-stat-slot">
                <dt className="max-w-full truncate text-xs text-fg-muted">{stat.label}</dt>
                <dd className="font-display text-xl font-semibold tabular-nums leading-tight text-fg">{formatCount(stat.value, lang)}</dd>
              </div>
            ) : (
              <div key={key} aria-hidden className="w-20" data-testid="source-stat-slot" />
            ),
          )}
        </dl>

        {/* Fixed width: the account button's place is kept when there is none, so icons line up across cards. */}
        <div className="flex shrink-0 items-center gap-0.5" data-testid="source-actions">
          <IconButton
            label={t('refreshSource', { name: s.name })}
            icon={<RefreshCw aria-hidden className={clsx('size-4', busy && 'motion-safe:animate-spin')} />}
            disabled={busy || s.m3u?.origin === 'text'}
            onClick={props.onRefresh}
            data-testid="source-refresh"
          />
          {hasAccountInfo(s) && props.onAccount ? (
            <IconButton
              label={t('accountFor', { name: s.name })}
              icon={<IdCard aria-hidden className="size-4" />}
              onClick={props.onAccount}
              data-testid="source-account"
            />
          ) : (
            <span aria-hidden className="h-10 w-10" />
          )}
          <IconButton label={t('editSource', { name: s.name })} icon={<Pencil aria-hidden className="size-4" />} onClick={props.onEdit} data-testid="source-edit" />
          <IconButton
            label={t('removeSource', { name: s.name })}
            icon={<Trash2 aria-hidden className="size-4" />}
            onClick={props.onRemove}
            disabled={busy}
            data-testid="source-remove"
          />
        </div>
      </div>

      {busy || cancelled ? (
        <div className="border-t border-divider px-4 py-2.5">
          <ImportProgressView
            entry={progress}
            compact
            kind={s.kind}
            // Cancel needs a running import the core knows about: wait for its first event.
            onCancel={progress && props.onCancelImport ? props.onCancelImport : undefined}
            cancelling={props.cancelling}
          />
        </div>
      ) : s.lastError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-t border-danger/40 bg-danger/10 px-4 py-2.5 text-sm" data-testid="source-error">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-danger" />
          <SourceErrorText source={s} />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={props.onEdit} aria-describedby={nameId}>
              {t('checkSettings')}
            </Button>
            {s.m3u?.origin !== 'text' ? (
              <Button size="sm" variant="secondary" onClick={props.onRefresh} aria-describedby={nameId} data-testid="source-error-retry">
                {t('tryAgain')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : guide ? (
        <div className="border-t border-divider px-4 py-2.5">
          <GuideProgressView guide={guide} />
        </div>
      ) : null}
    </li>
  );
}
