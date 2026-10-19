/** Sort and filter for the sources list, persisted in localStorage. */

import type { Source, SourceKind } from '@/api/types';
import { intlLocale } from '@/lib/intl';

export const SORTS = ['manual', 'name', 'kind', 'added', 'refreshed'] as const;
export type SourceSort = (typeof SORTS)[number];
export const KIND_FILTERS = ['all', 'm3u', 'xtream', 'stalker'] as const;
export type KindFilter = (typeof KIND_FILTERS)[number];
export const STATUS_FILTERS = ['all', 'ok', 'error'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface ListView {
  sort: SourceSort;
  kind: KindFilter;
  status: StatusFilter;
}

export const DEFAULT_VIEW: ListView = { sort: 'manual', kind: 'all', status: 'all' };
export const VIEW_STORAGE_KEY = 'tsrust.sources.view';

const pick = <T extends string>(allowed: readonly T[], v: unknown, fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

export function loadView(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): ListView {
  try {
    const raw = storage?.getItem(VIEW_STORAGE_KEY);
    if (!raw) return DEFAULT_VIEW;
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      sort: pick(SORTS, o.sort, DEFAULT_VIEW.sort),
      kind: pick(KIND_FILTERS, o.kind, DEFAULT_VIEW.kind),
      status: pick(STATUS_FILTERS, o.status, DEFAULT_VIEW.status),
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: ListView, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage full or blocked: the view just does not persist.
  }
}

/** True when the list shows every source in stored order, the only view where reordering makes sense. */
export function isManualView(view: ListView): boolean {
  return view.sort === 'manual' && view.kind === 'all' && view.status === 'all';
}

export function isFiltered(view: ListView): boolean {
  return view.kind !== 'all' || view.status !== 'all';
}

const KIND_ORDER: Record<SourceKind, number> = { m3u: 0, xtream: 1, stalker: 2 };
const time = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

export function applyView(sources: readonly Source[], view: ListView, lang = 'en'): Source[] {
  const collator = new Intl.Collator(intlLocale(lang), { numeric: true, sensitivity: 'base' });
  const byName = (a: Source, b: Source) => collator.compare(a.name, b.name);
  const list = sources.filter(
    (s) => (view.kind === 'all' || s.kind === view.kind) && (view.status === 'all' || (view.status === 'error') === Boolean(s.lastError)),
  );
  switch (view.sort) {
    case 'manual':
      return list;
    case 'name':
      return list.sort(byName);
    case 'kind':
      return list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b));
    case 'added':
      // Newest first.
      return list.sort((a, b) => time(b.createdAt) - time(a.createdAt) || byName(a, b));
    case 'refreshed':
      // Most recently refreshed first; never-refreshed sources last.
      return list.sort((a, b) => time(b.lastRefreshAt) - time(a.lastRefreshAt) || byName(a, b));
  }
}
