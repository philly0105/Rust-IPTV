/**
 * Pure queue model for /downloads. The page shows every row that is not
 * completed: transfers in flight (downloading, queued, paused) and rows that
 * need attention (failed, canceled). Completed rows live in My Videos.
 */

import type { Download, DownloadStatus } from '@/api/types';

export type QueueAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'reveal';
export type QueueSection = 'active' | 'attention';

const STATUS_ORDER: Record<DownloadStatus, number> = {
  downloading: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  canceled: 4,
  completed: 5,
};

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
 * Splits the list into the two sections. Active rows run in queue order
 * (downloading, then queued FIFO, then paused); attention rows show the most
 * recent failure first. Completed rows are dropped.
 */
export function partitionQueue(downloads: readonly Download[]): { active: Download[]; attention: Download[] } {
  const active: Download[] = [];
  const attention: Download[] = [];
  for (const d of downloads) {
    const s = sectionOf(d.status);
    if (s === 'active') active.push(d);
    else if (s === 'attention') attention.push(d);
  }
  active.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byCreatedAsc(a, b));
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

/** Actions offered for a row, in display order. The first one is the primary action. */
export function actionsFor(status: DownloadStatus, opts: { canReveal: boolean; hasFile: boolean }): QueueAction[] {
  switch (status) {
    case 'downloading':
    case 'queued':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel', 'remove'];
    case 'failed':
      return opts.canReveal && opts.hasFile ? ['retry', 'reveal', 'remove'] : ['retry', 'remove'];
    case 'canceled':
      return ['retry', 'remove'];
    case 'completed':
      return opts.canReveal && opts.hasFile ? ['reveal', 'remove'] : ['remove'];
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
