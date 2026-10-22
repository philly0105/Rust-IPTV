/**
 * Pure queue model for /downloads. The page shows every row that is not
 * completed: transfers in flight (downloading, queued, paused) and rows that
 * need attention (failed, canceled). Completed rows live in My Videos.
 */

import type { Download, DownloadStatus } from '@/api/types';

export type QueueAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'reveal' | 'next';
export type QueueSection = 'active' | 'attention';

export function sectionOf(status: DownloadStatus): QueueSection | undefined {
  if (status === 'downloading' || status === 'queued' || status === 'paused') return 'active';
  if (status === 'failed' || status === 'canceled') return 'attention';
  return undefined;
}

function byCreatedAsc(a: Download, b: Download): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id - b.id;
}

function byUpdatedDesc(a: Download, b: Download): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id;
}

/**
 * Splits the list into the two sections. Active rows keep the order they were
 * added in (each row shows its own status), so pausing or resuming one never
 * moves it out from under the pointer; attention rows show the most recent
 * failure first. Completed rows are dropped.
 */
export function partitionQueue(downloads: readonly Download[]): { active: Download[]; attention: Download[] } {
  const active: Download[] = [];
  const attention: Download[] = [];
  for (const d of downloads) {
    const s = sectionOf(d.status);
    if (s === 'active') active.push(d);
    else if (s === 'attention') attention.push(d);
  }
  active.sort(byCreatedAsc);
  attention.sort(byUpdatedDesc);
  return { active, attention };
}

export type QueueRow =
  | { kind: 'header'; section: QueueSection; count: number; key: string }
  | { kind: 'item'; section: QueueSection; download: Download; key: string };

/** Flattens the sections into one virtualizable row list with section headers. */
export function buildQueueRows(downloads: readonly Download[]): QueueRow[] {
  const { active, attention } = partitionQueue(downloads);
  const rows: QueueRow[] = [];
  const push = (section: QueueSection, list: Download[]) => {
    if (list.length === 0) return;
    rows.push({ kind: 'header', section, count: list.length, key: `h-${section}` });
    for (const d of list) rows.push({ kind: 'item', section, download: d, key: `d-${d.id}` });
  };
  push('active', active);
  push('attention', attention);
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
