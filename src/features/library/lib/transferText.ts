/**
 * Words for a running transfer's speed breakdown (`TransferStats`): the row's counts, its quiet
 * note line, and the details dialog's limit and limiting-factor sentences. Pure, so the row and
 * the dialog say the same thing and tests can check every kind.
 */

import type { TFunction } from 'i18next';

import type { Download, Limiting, MirrorDropReason, OneConnectionReason, SourceStat, TransferNote, TransferStats } from '@/api/types';

import { formatSpeedLimit } from './format';

/** A source's name for a sentence; the caller decides what a removed source reads as. */
export type NameOf = (sourceId: string) => string;

/**
 * "4 connections · 3 sources", with only the parts above one: nothing for a single source on one
 * connection, "2 connections" for a split file on one source.
 */
export function countsText(t: TFunction<'library'>, connections: number | undefined, sources: number | undefined): string {
  const parts: string[] = [];
  if (connections !== undefined && connections > 1) parts.push(t('transferConnections', { count: connections }));
  if (sources !== undefined && sources > 1) parts.push(t('transferSources', { count: sources }));
  return parts.join(' · ');
}

/**
 * The source a run downloads from when it is not the row's own (queue spreading): the row's
 * `servedBy`, else the live breakdown's first source (the authority) when it differs.
 */
export function servedByOf(d: Pick<Download, 'servedBy' | 'ref'>, stats: TransferStats | undefined): string | undefined {
  if (d.servedBy) return d.servedBy;
  const authority = stats?.sources.find((s) => s.role === 'primary') ?? stats?.sources[0];
  return authority && authority.sourceId !== d.ref.sourceId ? authority.sourceId : undefined;
}

/** The newest note (notes are oldest first), for the row's quiet line. */
export function latestNote(stats: TransferStats | undefined): TransferNote | undefined {
  return stats?.notes.at(-1);
}

const DROP_KEYS: Record<MirrorDropReason, string> = {
  refused: 'noteMirrorDroppedRefused',
  failed: 'noteMirrorDroppedFailed',
  playback: 'noteMirrorDroppedPlayback',
  queue: 'noteMirrorDroppedQueue',
  unavailable: 'noteMirrorDroppedUnavailable',
};

const ONE_CONNECTION_KEYS: Record<OneConnectionReason, string> = {
  changed: 'noteOneConnectionChanged',
  refused: 'noteOneConnectionRefused',
  noHoles: 'noteOneConnectionNoHoles',
  unreachable: 'noteOneConnectionUnreachable',
};

/**
 * A note as one plain sentence. Notes are status, never errors: a mirror that drops out or a
 * refused probe leaves the download running, and the line says what changed.
 */
export function noteText(t: TFunction<'library'>, note: TransferNote, nameOf: NameOf): string {
  switch (note.kind) {
    case 'mirrorAdded':
      return t('noteMirrorAdded', { name: nameOf(note.sourceId) });
    case 'mirrorDropped':
      return t(DROP_KEYS[note.reason] ?? 'noteMirrorDroppedFailed', { name: nameOf(note.sourceId) });
    case 'mirrorMismatch':
      return t('noteMirrorMismatch', { name: nameOf(note.sourceId) });
    case 'probeAccepted':
      return t('noteProbeAccepted', { name: nameOf(note.sourceId), count: note.limit });
    case 'probeRefused':
      return t('noteProbeRefused', { name: nameOf(note.sourceId) });
    case 'probeKickedOldest':
      return t('noteProbeKickedOldest', { name: nameOf(note.sourceId) });
    case 'oneConnection':
      return t(ONE_CONNECTION_KEYS[note.reason] ?? 'noteOneConnectionRefused');
    case 'urlRefreshed':
      return t('noteUrlRefreshed');
    default:
      // A kind a newer engine added: no line rather than a raw key.
      return '';
  }
}

/** What holds the speed back, as one plain sentence. Every kind of `Limiting` has one. */
export function limitingText(t: TFunction<'library'>, limiting: Limiting, nameOf: NameOf, lang: string): string {
  switch (limiting.kind) {
    case 'speedLimit':
      return t('limitingSpeedLimit', { speed: formatSpeedLimit(limiting.bytesPerSecond, lang) });
    case 'noRanges':
      return t('limitingNoRanges');
    case 'smallFile':
      return t('limitingSmallFile');
    case 'singleConnection':
      return t('limitingSingleConnection', { name: nameOf(limiting.sourceId) });
    case 'maxConnections':
      return t('limitingMaxConnections', { count: limiting.max });
    case 'playback':
      return t('limitingPlayback', { name: nameOf(limiting.sourceId) });
    case 'otherDownloads':
      return t('limitingOtherDownloads', { name: nameOf(limiting.sourceId) });
    case 'refused':
      return t('limitingRefused', { name: nameOf(limiting.sourceId) });
    case 'line':
      return t('limitingLine');
    case 'perConnection': {
      // A zero figure (most connections stalled for a second) has nothing to say.
      const speed = formatSpeedLimit(limiting.bytesPerSecond, lang);
      return speed ? t('limitingPerConnection', { speed }) : '';
    }
    case 'accountLimit':
      return t('limitingAccountLimit', { name: nameOf(limiting.sourceId), count: limiting.limit });
    default:
      return '';
  }
}

/** A source's connection limit and where it comes from: the account, a test, or nowhere yet. */
export function limitText(t: TFunction<'library'>, s: Pick<SourceStat, 'limit' | 'limitKind'>): string {
  if (s.limit === undefined || s.limitKind === 'unknown') return t('detailsLimitUnknown');
  return t(s.limitKind === 'learned' ? 'detailsLimitLearned' : 'detailsLimitReported', { count: s.limit });
}
