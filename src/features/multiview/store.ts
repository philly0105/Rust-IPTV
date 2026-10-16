/**
 * The wall (contract C4), persisted to localStorage `tsrust.multiview` so it comes back
 * after a reload or a restart. Plus the wall's own audio preferences (volume of the tile
 * with sound, mute all) under `tsrust.multiview.audio`.
 *
 * Invariants every action keeps:
 * - at most four tiles, no channel twice;
 * - the layout holds every tile (adding a third tile to 1x2 switches to 2x2; 1x2 cannot be
 *   chosen while more than two tiles are up);
 * - exactly one tile has sound while the wall has any: the first tile added gets it, and
 *   closing the tile with sound hands it to the first tile left.
 *
 * Stored values are parsed defensively: a corrupt or hand-edited entry yields the valid
 * part (or an empty wall), never a crash.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand';

import type { ContentType, ItemRef } from '@/api/types';

import { fitLayout, isLayout, layoutFits, MAX_TILES } from './layout';
import type { MultiviewChannelInput, MultiviewLayout, MultiviewState, MultiviewTile } from './types';

export const STORAGE_KEY = 'tsrust.multiview';
export const AUDIO_STORAGE_KEY = 'tsrust.multiview.audio';
const VERSION = 1;
const DEFAULT_LAYOUT: MultiviewLayout = '2x2';

const CONTENT_TYPES: readonly ContentType[] = ['live', 'movie', 'series', 'radio'];

function sameRef(a: ItemRef, b: ItemRef): boolean {
  return a.sourceId === b.sourceId && a.contentType === b.contentType && a.itemId === b.itemId;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage access can throw (privacy modes, sandboxed frames).
    return null;
  }
}

function isRef(v: unknown): v is ItemRef {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['sourceId'] === 'string' &&
    r['sourceId'] !== '' &&
    typeof r['itemId'] === 'string' &&
    r['itemId'] !== '' &&
    typeof r['contentType'] === 'string' &&
    (CONTENT_TYPES as readonly string[]).includes(r['contentType'])
  );
}

/** Only the C4 fields, trimmed; a caller may pass a wider object (a whole Channel). */
export function cleanInput(ch: MultiviewChannelInput): MultiviewChannelInput {
  const { sourceId, contentType, itemId } = ch.ref;
  const out: MultiviewChannelInput = {
    ref: { sourceId, contentType, itemId },
    title: (typeof ch.title === 'string' ? ch.title.trim() : '') || itemId,
  };
  if (typeof ch.logo === 'string' && ch.logo.trim()) out.logo = ch.logo.trim();
  if (typeof ch.number === 'number' && Number.isFinite(ch.number)) out.number = ch.number;
  if (typeof ch.categoryId === 'string' && ch.categoryId) out.categoryId = ch.categoryId;
  return out;
}

let keySeq = 0;

/** A tile key unique on this wall. */
function newKey(taken: readonly MultiviewTile[]): string {
  for (;;) {
    keySeq += 1;
    const key = `t${Date.now().toString(36)}${keySeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!taken.some((t) => t.key === key)) return key;
  }
}

type WallData = Pick<MultiviewState, 'tiles' | 'layout' | 'audioKey'>;

const EMPTY: WallData = { tiles: [], layout: DEFAULT_LAYOUT, audioKey: null };

/** Applies the invariants to any wall data. */
export function normalizeWall(data: WallData): WallData {
  const tiles: MultiviewTile[] = [];
  for (const t of data.tiles) {
    if (tiles.length >= MAX_TILES) break;
    if (tiles.some((x) => sameRef(x.ref, t.ref) || x.key === t.key)) continue;
    tiles.push(t);
  }
  const layout = fitLayout(isLayout(data.layout) ? data.layout : DEFAULT_LAYOUT, tiles.length);
  const audioKey = tiles.some((t) => t.key === data.audioKey) ? data.audioKey : (tiles[0]?.key ?? null);
  return { tiles, layout, audioKey };
}

/** Parses a stored wall; anything unreadable gives the valid part or an empty wall. */
export function parseWall(raw: string | null): WallData {
  if (!raw) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY;
  const o = parsed as Record<string, unknown>;
  const tiles: MultiviewTile[] = [];
  if (Array.isArray(o['tiles'])) {
    for (const item of o['tiles'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const t = item as Record<string, unknown>;
      if (!isRef(t['ref'])) continue;
      const key = typeof t['key'] === 'string' && t['key'] ? t['key'] : newKey(tiles);
      const input = cleanInput({
        ref: t['ref'],
        title: typeof t['title'] === 'string' ? t['title'] : '',
        ...(typeof t['logo'] === 'string' ? { logo: t['logo'] } : {}),
        ...(typeof t['number'] === 'number' ? { number: t['number'] } : {}),
        ...(typeof t['categoryId'] === 'string' ? { categoryId: t['categoryId'] } : {}),
      });
      tiles.push({ ...input, key });
    }
  }
  return normalizeWall({
    tiles,
    layout: isLayout(o['layout']) ? o['layout'] : DEFAULT_LAYOUT,
    audioKey: typeof o['audioKey'] === 'string' ? o['audioKey'] : null,
  });
}

function readWall(): WallData {
  try {
    return parseWall(storage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return EMPTY;
  }
}

function writeWall(data: WallData): void {
  try {
    const s = storage();
    if (!s) return;
    if (data.tiles.length === 0 && data.layout === DEFAULT_LAYOUT) {
      s.removeItem(STORAGE_KEY);
      return;
    }
    s.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, tiles: data.tiles, layout: data.layout, audioKey: data.audioKey }));
  } catch {
    // Quota or privacy mode: the wall still works for this session.
  }
}

export const useMultiviewStore: UseBoundStore<StoreApi<MultiviewState>> = create<MultiviewState>()((set, get) => ({
  ...readWall(),

  add(ch) {
    const s = get();
    if (s.tiles.some((t) => sameRef(t.ref, ch.ref))) return 'duplicate';
    if (s.tiles.length >= MAX_TILES) return 'full';
    const tile: MultiviewTile = { ...cleanInput(ch), key: newKey(s.tiles) };
    const tiles = [...s.tiles, tile];
    set({ tiles, layout: fitLayout(s.layout, tiles.length), audioKey: s.audioKey ?? tile.key });
    return 'added';
  },

  remove(key) {
    const s = get();
    const tiles = s.tiles.filter((t) => t.key !== key);
    if (tiles.length === s.tiles.length) return;
    set({ tiles, audioKey: s.audioKey === key || !s.audioKey ? (tiles[0]?.key ?? null) : s.audioKey });
  },

  replace(key, ch) {
    const s = get();
    const i = s.tiles.findIndex((t) => t.key === key);
    if (i < 0) return;
    // The channel is already on another tile: two tiles of one stream would only cost a connection.
    if (s.tiles.some((t, j) => j !== i && sameRef(t.ref, ch.ref))) return;
    const tiles = s.tiles.slice();
    tiles[i] = { ...cleanInput(ch), key };
    set({ tiles });
  },

  swap(a, b) {
    if (a === b) return;
    const s = get();
    const i = s.tiles.findIndex((t) => t.key === a);
    const j = s.tiles.findIndex((t) => t.key === b);
    if (i < 0 || j < 0) return;
    const tiles = s.tiles.slice();
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
    set({ tiles });
  },

  setAudio(key) {
    const s = get();
    if (s.audioKey === key || !s.tiles.some((t) => t.key === key)) return;
    set({ audioKey: key });
  },

  setLayout(l) {
    const s = get();
    if (!isLayout(l) || l === s.layout || !layoutFits(l, s.tiles.length)) return;
    set({ layout: l });
  },

  clear() {
    if (get().tiles.length === 0) return;
    set({ tiles: [], audioKey: null });
  },
}));

useMultiviewStore.subscribe((s, prev) => {
  if (s.tiles !== prev.tiles || s.layout !== prev.layout || s.audioKey !== prev.audioKey) {
    writeWall({ tiles: s.tiles, layout: s.layout, audioKey: s.audioKey });
  }
});

/** Puts back a wall saved with `snapshotWall` (undo of Clear and Close). */
export function restoreWall(data: WallData): void {
  useMultiviewStore.setState(normalizeWall(data));
}

export function snapshotWall(): WallData {
  const { tiles, layout, audioKey } = useMultiviewStore.getState();
  return { tiles, layout, audioKey };
}

/**
 * Undo of Close: puts `tile` back at `index` (or the end), with sound when it had it.
 * `false` when it cannot come back: the channel is on the wall again or the wall is full.
 */
export function reinsertTile(tile: MultiviewTile, index: number, hadSound: boolean): boolean {
  const s = useMultiviewStore.getState();
  if (s.tiles.some((t) => sameRef(t.ref, tile.ref)) || s.tiles.length >= MAX_TILES) return false;
  const tiles = s.tiles.slice();
  const back: MultiviewTile = s.tiles.some((t) => t.key === tile.key) ? { ...tile, key: newKey(s.tiles) } : tile;
  tiles.splice(Math.max(0, Math.min(index, tiles.length)), 0, back);
  useMultiviewStore.setState(normalizeWall({ tiles, layout: s.layout, audioKey: hadSound ? back.key : s.audioKey }));
  return true;
}

/** Undo of Clear: the cleared wall comes back, merged with anything added since. */
export function restoreClearedWall(cleared: WallData): void {
  const s = snapshotWall();
  restoreWall({ tiles: [...cleared.tiles, ...s.tiles], layout: cleared.layout, audioKey: cleared.audioKey ?? s.audioKey });
}

export type { WallData };

// ---------------------------------------------------------------------------
// Audio preferences of the wall
// ---------------------------------------------------------------------------

export interface MultiviewAudioState {
  /** Volume of the tile with sound, 0..1. */
  volume: number;
  /** Every tile silent. */
  muted: boolean;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  toggleMuted(): void;
}

function clampVolume(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export function parseAudio(raw: string | null): Pick<MultiviewAudioState, 'volume' | 'muted'> {
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!o || typeof o !== 'object') return { volume: 1, muted: false };
    return { volume: clampVolume(o['volume']), muted: o['muted'] === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

export const useMultiviewAudio: UseBoundStore<StoreApi<MultiviewAudioState>> = create<MultiviewAudioState>()((set, get) => ({
  ...parseAudio((() => {
    try {
      return storage()?.getItem(AUDIO_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  })()),
  setVolume(v) {
    const volume = clampVolume(v);
    // Turning the volume up from zero or while muted is a request to hear the tile.
    set(volume > 0 && get().muted ? { volume, muted: false } : { volume });
  },
  setMuted(m) {
    set({ muted: m });
  },
  toggleMuted() {
    set({ muted: !get().muted });
  },
}));

useMultiviewAudio.subscribe((s) => {
  try {
    storage()?.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ volume: s.volume, muted: s.muted }));
  } catch {
    // Not persisted this session.
  }
});

/** Tests: fresh wall and audio state, read again from storage. */
export function __reloadMultiviewForTests(): void {
  useMultiviewStore.setState(readWall());
  useMultiviewAudio.setState(parseAudio(storage()?.getItem(AUDIO_STORAGE_KEY) ?? null));
}
