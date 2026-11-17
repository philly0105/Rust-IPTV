/**
 * Pure queue model for /downloads. The page shows transfers in flight
 * (downloading, queued, paused), rows that need attention (failed, canceled)
 * and the latest finished ones, so a download that just finished is still
 * where the user left it. Every completed row lives in My Videos.
 */

import type { Download, DownloadStatus } from '@/api/types';

export type QueueAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'reveal' | 'next';
export type QueueSection = 'active' | 'attention' | 'finished';

/**
 * The toast of one download: a later change of the same download updates it in place, so the
 * finished toast replaces the "Download queued" one a fast download would otherwise stack under.
 */
export const downloadToastId = (id: number) => `download-${id}`;

export function sectionOf(status: DownloadStatus): QueueSection {
  if (status === 'downloading' || status === 'queued' || status === 'paused') return 'active';
  if (status === 'failed' || status === 'canceled') return 'attention';
  return 'finished';
}

function byCreatedAsc(a: Download, b: Download): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

function byUpdatedDesc(a: Download, b: Download): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id;
}

const finishedAt = (d: Download) => d.completedAt ?? d.updatedAt;

function byFinishedDesc(a: Download, b: Download): number {
  return finishedAt(b).localeCompare(finishedAt(a)) || b.id - a.id;
}

/** How many finished downloads the page keeps under the queue; My Videos has them all. */
const FINISHED_SHOWN = 10;

/**
 * Splits the list into the three sections. Active rows keep the order they
 * were added in (each row shows its own status), so pausing or resuming one
 * never moves it out from under the pointer; attention rows show the most
 * recent failure first, and finished rows the latest `FINISHED_SHOWN`, newest first.
 */
export function partitionQueue(downloads: readonly Download[]): { active: Download[]; attention: Download[]; finished: Download[] } {
  const active: Download[] = [];
  const attention: Download[] = [];
  const finished: Download[] = [];
  for (const d of downloads) {
    const s = sectionOf(d.status);
    if (s === 'active') active.push(d);
    else if (s === 'attention') attention.push(d);
    else finished.push(d);
  }
  active.sort(byCreatedAsc);
  attention.sort(byUpdatedDesc);
  finished.sort(byFinishedDesc);
  return { active, attention, finished: finished.slice(0, FINISHED_SHOWN) };
}

export type QueueRow =
  | { kind: 'header'; section: QueueSection; count: number; key: string }
  | { kind: 'item'; section: QueueSection; download: Download; key: string };

/** Flattens the sections into one virtualizable row list with section headers. */
export function buildQueueRows(downloads: readonly Download[]): QueueRow[] {
  const { active, attention, finished } = partitionQueue(downloads);
  const rows: QueueRow[] = [];
  const push = (section: QueueSection, list: Download[]) => {
    if (list.length === 0) return;
    rows.push({ kind: 'header', section, count: list.length, key: `h-${section}` });
    for (const d of list) rows.push({ kind: 'item', section, download: d, key: `d-${d.id}` });
  };
  push('active', active);
  push('attention', attention);
  push('finished', finished);
  return rows;
}

const PAUSE_CANCEL: readonly QueueAction[] = ['pause', 'cancel'];
const PAUSE_CANCEL_NEXT: readonly QueueAction[] = ['pause', 'cancel', 'next'];
const RESUME_REMOVE: readonly QueueAction[] = ['resume', 'remove'];
const RETRY_REVEAL_REMOVE: readonly QueueAction[] = ['retry', 'reveal', 'remove'];
const RETRY_REMOVE: readonly QueueAction[] = ['retry', 'remove'];
const REVEAL_REMOVE: readonly QueueAction[] = ['reveal', 'remove'];
const REMOVE: readonly QueueAction[] = ['remove'];

/**
 * Actions offered for a row, in display order. The first one is the primary
 * action. A row keeps two buttons in the same places while it toggles between
 * downloading and paused (Pause/Resume, then Cancel/Remove), so nothing shifts
 * under the pointer; a paused transfer is removed rather than canceled, since
 * a canceled one would only wait in Needs attention to be removed. A queued row
 * adds Download next last, so Pause and Cancel stay put when it starts. The
 * same array comes back for the same answer, so a memoised row keeps its props.
 */
export function actionsFor(status: DownloadStatus, opts: { canReveal: boolean; hasFile: boolean }): readonly QueueAction[] {
  switch (status) {
    case 'downloading':
      return PAUSE_CANCEL;
    case 'queued':
      return PAUSE_CANCEL_NEXT;
    case 'paused':
      return RESUME_REMOVE;
    case 'failed':
      return opts.canReveal && opts.hasFile ? RETRY_REVEAL_REMOVE : RETRY_REMOVE;
    case 'canceled':
      return RETRY_REMOVE;
    case 'completed':
      return opts.canReveal && opts.hasFile ? REVEAL_REMOVE : REMOVE;
  }
}

export interface QueueCounts {
  downloading: number;
  queued: number;
  paused: number;
  attention: number;
}

/** Counts used by the header summary and the rail badge. */
export function queueCounts(downloads: readonly Download[]): QueueCounts {
  const c: QueueCounts = { downloading: 0, queued: 0, paused: 0, attention: 0 };
  for (const d of downloads) {
    if (d.status === 'downloading') c.downloading += 1;
    else if (d.status === 'queued') c.queued += 1;
    else if (d.status === 'paused') c.paused += 1;
    else if (d.status === 'failed' || d.status === 'canceled') c.attention += 1;
  }
  return c;
}

/**
 * How a row, a dialog or a toast names a download. An archived programme is stored under its
 * channel (title "US| ESPN2 FHD", subtitle "SportsCenter · Mon 9:00 AM"), so four programmes from
 * one channel would all read as the channel: it leads with the programme instead, and the channel
 * and air time go under it ("SportsCenter", "US| ESPN2 FHD · Mon 9:00 AM").
 */
export function downloadNames(d: Pick<Download, 'title' | 'subtitle' | 'episodeId'>): { title: string; subtitle?: string } {
  const sub = d.subtitle?.trim();
  if (!sub) return { title: d.title };
  if (!d.episodeId?.startsWith('catchup:')) return { title: d.title, subtitle: sub };
  const at = sub.lastIndexOf(' · ');
  if (at <= 0) return { title: sub, subtitle: d.title };
  return { title: sub.slice(0, at), subtitle: `${d.title} · ${sub.slice(at + 3)}` };
}
