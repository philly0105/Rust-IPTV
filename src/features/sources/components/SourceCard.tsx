import { clsx } from 'clsx';
import { CircleAlert, EyeOff, GripVertical, IdCard, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { memo, useId, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { AccountStatus, ScheduleEntry } from '@/api/rpc';
import type { Source, SourceKind } from '@/api/types';

import { sourceHomePath } from '@/shell/railLinks';
import { useMediaQuery } from '@/shell/useMediaQuery';
import { Badge, Button, IconButton, Menu, MetaLine, Tooltip, type MenuItem } from '@/ui';
import { baseName } from '../lib/files';
import { absoluteTime, formatCount, relativeTime } from '../lib/format';
import { useSourceGuide } from '../lib/epgRefresh';
import { isRunningPhase, useImportProgressStore, useSourceProgress } from '../lib/progress';
import { redactText } from '../lib/redact';
import { SOURCE_ERROR_KEYS, classifySourceError, sourceErrorDetail, splitErrorText } from '../lib/sourceError';
import { displayHost } from '../lib/validate';
import { AccountBadges } from './AccountBadges';
import { hasAccountInfo } from './AccountPanel';
import { GuideProgressView } from './GuideProgressView';
import { ImportProgressView } from './ImportProgressView';
import { SourceMonogram } from './SourceMonogram';

/** The kind's short name for the card's badge ("Xtream"); the full one is the badge's accessible text. */
const KIND_SHORT: Record<SourceKind, string> = { m3u: 'kindM3uShort', xtream: 'kindXtreamShort', stalker: 'kindStalkerShort' };

/**
 * Phone widths: the card keeps one action button, More, beside the name, and Refresh and Edit
 * move into its menu; three 44 px touch targets there would leave the name a few letters.
 */
const PHONE_QUERY = '(max-width: 639.98px)';

/** A pasted or uploaded playlist: nothing to download again, so its refresh re-imports the stored text. */
export function isTextSource(s: Pick<Source, 'm3u'>): boolean {
  return s.m3u?.origin === 'text';
}

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
/**
 * The error text grows from a 12rem basis, so on a narrow card the buttons wrap
 * below it. With `flex-1` (basis 0) everything fit on one line and the text was
 * squeezed to a column a few letters wide at 390 px (L4-settings-3).
 */
const ERROR_TEXT = 'min-w-0 grow basis-48 text-fg';

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
      <div className={ERROR_TEXT}>
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
    <div className={ERROR_TEXT}>
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
  refreshing: boolean;
  dragging: boolean;
  dropTarget: 'before' | 'after' | null;
  onRefresh: (s: Source) => void;
  onEdit: (s: Source) => void;
  /** Opens the subscription details (Xtream and Stalker only). */
  onAccount?: (s: Source) => void;
  /** Opens the source's hidden and renamed channels, with Reset all edits (SS-3). */
  onChannelEdits?: (s: Source) => void;
  onRemove: (s: Source) => void;
  /** Stops the running import or refresh (C8). */
  onCancelImport?: (id: string) => void;
  /** False while the list is sorted or filtered: order only changes in the manual view. */
  reorderable?: boolean;
  onMove: (id: string, to: number) => void;
  onDragStart: (id: string, e: DragEvent<HTMLElement>) => void;
  onDragOver: (id: string, e: DragEvent<HTMLElement>) => void;
  onDrop: (id: string, e: DragEvent<HTMLElement>) => void;
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

/**
 * The card is memoised (VD-5): its import progress and cancel state come from the progress store
 * per source, and its handlers take the source (or its id), so the page can pass the same
 * functions to every card. An import event then re-renders only the card it is about.
 *
 * Layout: the monogram, then the identity (name, kind, the subscription) over one line of
 * status (where it comes from, when it last and next refreshes), then the counts it has, and
 * the actions. Below @3xl the counts join the status as a line of text and the actions sit at
 * the top end beside the name. Only the stats a source has are shown, right-aligned, so the
 * last one always meets the actions and no card shows an empty column.
 */
export const SourceCard = memo(function SourceCard(props: SourceCardProps) {
  const { source: s, index, total, refreshing, reorderable = true } = props;
  const { t, i18n } = useTranslation('sources');
  const progress = useSourceProgress(s.id);
  const cancelling = useImportProgressStore((st) => st.cancelling[s.id] === true);
  const lang = i18n.language;
  const busy = refreshing || isRunningPhase(progress?.phase);
  // A cancelled run lingers briefly (LINGER_MS) in place of the error strip: the old catalog and its error are unchanged.
  const cancelled = !busy && progress?.phase === 'cancelled';
  const guide = useSourceGuide(s.epg);
  // Names the source for the error strip's buttons: several cards can show "Try again" at once.
  const nameId = useId();
  const text = isTextSource(s);
  // One card has nowhere to move: no grip, and Alt+Arrow does nothing.
  const canMove = reorderable && total > 1;

  // `channelCount` is live channels only; radio gets its own stat when the source has any.
  const radio = radioCount(s);
  const live = s.channelCount;
  const stats: { key: string; value: number; label: string }[] = [{ key: 'channels', value: live, label: t('statChannels', { count: live }) }];
  if (radio > 0) stats.push({ key: 'radio', value: radio, label: t('statRadio', { count: radio }) });
  if (s.kind !== 'm3u' || s.movieCount > 0) stats.push({ key: 'movies', value: s.movieCount, label: t('statMovies', { count: s.movieCount }) });
  if (s.kind !== 'm3u' || s.seriesCount > 0) stats.push({ key: 'series', value: s.seriesCount, label: t('statSeries', { count: s.seriesCount }) });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Alt+Arrow anywhere on the card, or plain arrows on the grip, move it.
    const onGrip = (e.target as HTMLElement).dataset.grip === 'true';
    if (!canMove || !(e.altKey || onGrip)) return;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      props.onMove(s.id, index - 1);
    } else if (e.key === 'ArrowDown' && index < total - 1) {
      e.preventDefault();
      props.onMove(s.id, index + 1);
    } else if (onGrip && e.key === 'Home' && index > 0) {
      e.preventDefault();
      props.onMove(s.id, 0);
    } else if (onGrip && e.key === 'End' && index < total - 1) {
      e.preventDefault();
      props.onMove(s.id, total - 1);
    }
  };

  const refreshed = relativeTime(s.lastRefreshAt, lang);
  const failed = s.lastError ? relativeTime(s.lastErrorAt, lang) : undefined;
  const next = s.autoRefresh && props.schedule && !busy ? nextRefreshText(props.schedule, lang, t) : undefined;
  const origin = sourceOrigin(s, t);

  const phone = useMediaQuery(PHONE_QUERY);
  const refreshLabel = t(text ? 'reimportSource' : 'refreshSource', { name: s.name });
  const menu: MenuItem[] = [];
  if (phone) {
    menu.push({ id: 'refresh', label: refreshLabel, icon: <RefreshCw aria-hidden size={16} />, disabled: busy, onSelect: () => props.onRefresh(s) });
    menu.push({ id: 'edit', label: t('editSource', { name: s.name }), icon: <Pencil aria-hidden size={16} />, onSelect: () => props.onEdit(s) });
  }
  if (hasAccountInfo(s) && props.onAccount) {
    menu.push({ id: 'account', label: t('accountMenu'), icon: <IdCard aria-hidden size={16} />, onSelect: () => props.onAccount?.(s) });
  }
  // Renamed channels have no other way back to their provider's names in bulk.
  if (props.onChannelEdits && (live > 0 || radio > 0)) {
    menu.push({ id: 'edits', label: t('channelEditsMenu'), icon: <EyeOff aria-hidden size={16} />, onSelect: () => props.onChannelEdits?.(s) });
  }
  if (menu.length > 0) menu.push({ id: 'sep', type: 'separator' });
  menu.push({ id: 'remove', label: t('removeMenu'), icon: <Trash2 aria-hidden size={16} />, danger: true, disabled: busy, onSelect: () => props.onRemove(s) });

  return (
    <li
      data-testid="source-card"
      data-source-id={s.id}
      onKeyDown={onKeyDown}
      onDragOver={(e) => props.onDragOver(s.id, e)}
      onDrop={(e) => props.onDrop(s.id, e)}
      className={clsx(
        'group/card relative rounded-lg border bg-surface motion-safe:transition-colors',
        s.lastError && !busy ? 'border-danger/60' : 'border-edge hover:border-border',
        props.dragging && 'opacity-50',
      )}
    >
      {props.dropTarget ? (
        <span
          aria-hidden
          className={clsx('pointer-events-none absolute inset-x-3 h-0.5 rounded-full bg-accent', props.dropTarget === 'before' ? '-top-1.5' : '-bottom-1.5')}
        />
      ) : null}
      {/*
        Narrow cards are a grid: monogram, name and actions on the first row, status and counts
        across the card's full width below. From @3xl one flex row; the identity column then
        stops being `contents` and holds its lines itself.
      */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 p-3 @2xl:p-4 @3xl:flex @3xl:gap-4">
        {canMove ? (
          // The instructions ride on the grip (its tooltip and #sources-reorder-help), not on a line above the list.
          <Tooltip content={t('reorderHint')} describe={false} side="inline-end">
            <button
              type="button"
              draggable
              data-grip="true"
              onDragStart={(e) => props.onDragStart(s.id, e)}
              onDragEnd={props.onDragEnd}
              aria-label={t('reorderHandle', { name: s.name, position: index + 1, total })}
              aria-describedby="sources-reorder-help"
              // Not on touch screens (they cannot drag it) or narrow cards (the name needs the room): Alt+Arrow on the card still moves it.
              className="-ms-1 hidden h-11 w-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-fg-subtle opacity-60 hover:text-fg hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing group-hover/card:opacity-100 @3xl:pointer-fine:flex"
            >
              <GripVertical aria-hidden size={16} />
            </button>
          </Tooltip>
        ) : null}

        <SourceMonogram source={s} className="row-start-1" />

        <div className="contents @3xl:flex @3xl:min-w-0 @3xl:flex-1 @3xl:flex-col @3xl:gap-1">
          <div className="col-start-2 row-start-1 flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={sourceHomePath(s)}
              id={nameId}
              dir="auto"
              title={s.name}
              className="min-w-0 truncate rounded-xs text-body font-semibold text-fg underline-offset-4 hover:underline"
              data-testid="source-name"
            >
              {s.name}
            </Link>
            <Badge variant="outline" className="shrink-0" data-testid="source-kind">
              <span aria-hidden>{t(KIND_SHORT[s.kind])}</span>
              <span className="sr-only">{t(`kindLabel_${s.kind}`)}</span>
            </Badge>
            {/* Auto refresh is the default, so the card names the exception. Pasted text has no choice. */}
            {!s.autoRefresh && !text ? <Badge data-testid="source-manual-refresh">{t('manualRefreshBadge')}</Badge> : null}
            <AccountBadges status={props.account} warnDays={props.warnDays ?? 0} />
          </div>
          <MetaLine
            className="col-span-full row-start-2 text-body-sm"
            items={[
              <span key="origin" className="block max-w-full truncate" dir="auto" title={origin} data-testid="source-origin">
                {origin}
              </span>,
              // With an error and no good refresh yet, the error strip says it all; "Not refreshed yet" beside it reads as a contradiction.
              refreshed || !s.lastError ? (
                <span key="refreshed" className="whitespace-nowrap" title={absoluteTime(s.lastRefreshAt, lang)} data-testid="source-refreshed">
                  {refreshed ? t('refreshedAgo', { when: refreshed }) : t('neverRefreshed')}
                </span>
              ) : null,
              failed ? (
                <span key="failed" className="whitespace-nowrap text-danger" title={absoluteTime(s.lastErrorAt, lang)} data-testid="source-failed-at">
                  {t('failedAgo', { when: failed })}
                </span>
              ) : null,
              next ? (
                <span key="next" className="whitespace-nowrap text-fg-subtle" title={absoluteTime(props.schedule?.nextRefreshAt, lang)} data-testid="source-next-refresh">
                  {next}
                </span>
              ) : null,
            ]}
          />
          {/* Narrow cards: the counts as one line of text. */}
          <dl className="col-span-full row-start-3 flex flex-wrap gap-x-4 gap-y-0.5 @3xl:hidden">
            {stats.map((st) => (
              <div key={st.key} className="flex items-baseline gap-1 text-body-sm">
                <dt className="sr-only">{st.label}</dt>
                <dd className="flex items-baseline gap-1">
                  <span className="font-semibold tabular-nums text-fg">{formatCount(st.value, lang)}</span>
                  <span aria-hidden className="text-fg-muted">
                    {st.label}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <dl className="hidden shrink-0 items-center gap-6 @3xl:flex" data-testid="source-stats">
          {stats.map((st) => (
            <div key={st.key} className="flex min-w-14 flex-col-reverse items-end" data-testid="source-stat">
              <dt className="max-w-full truncate text-caption text-fg-muted">{st.label}</dt>
              <dd className="text-title-sm tabular-nums text-fg">{formatCount(st.value, lang)}</dd>
            </div>
          ))}
        </dl>

        {/* The same three places on every card, so the actions line up down the list (one on a phone). */}
        <div className="col-start-3 row-start-1 -me-1 flex shrink-0 items-center gap-0.5 @3xl:ms-2" data-testid="source-actions">
          {phone ? null : (
            <>
              <IconButton
                label={refreshLabel}
                icon={<RefreshCw aria-hidden size={16} className={clsx(busy && 'motion-safe:animate-spin')} />}
                disabled={busy}
                onClick={() => props.onRefresh(s)}
                data-testid="source-refresh"
              />
              <IconButton label={t('editSource', { name: s.name })} icon={<Pencil aria-hidden size={16} />} onClick={() => props.onEdit(s)} data-testid="source-edit" />
            </>
          )}
          <Menu label={t('moreActionsFor', { name: s.name })} items={menu} />
        </div>
      </div>

      {busy || cancelled ? (
        <div className="border-t border-divider px-4 py-2.5">
          <ImportProgressView
            entry={progress}
            compact
            kind={s.kind}
            // Cancel needs a running import the core knows about: wait for its first event.
            onCancel={progress && props.onCancelImport ? () => props.onCancelImport?.(s.id) : undefined}
            cancelling={cancelling}
          />
        </div>
      ) : s.lastError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-b-lg border-t border-danger/40 bg-danger/10 px-4 py-2.5 text-sm" data-testid="source-error">
          <CircleAlert aria-hidden size={16} className="shrink-0 text-danger" />
          <SourceErrorText source={s} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => props.onEdit(s)} aria-describedby={nameId}>
              {t('checkSettings')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => props.onRefresh(s)} aria-describedby={nameId} data-testid="source-error-retry">
              {t('tryAgain')}
            </Button>
          </div>
        </div>
      ) : guide ? (
        <div className="border-t border-divider px-4 py-2.5">
          <GuideProgressView guide={guide} />
        </div>
      ) : null}
    </li>
  );
});
