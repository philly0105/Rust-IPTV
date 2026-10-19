/**
 * Preferred-source pins for multi-source VOD ("Other sources").
 *
 * The core keeps them in its `vod_source_pins` table (C3) through `sourcePins.*` (C4), so
 * backups carry them and a restore brings them back. The match key mirrors the server's
 * same-title rule: normalized title base plus year.
 *
 * Builds before those commands kept pins in localStorage; {@link migrateLocalPins} moves them
 * into the core once.
 */

import { RpcError, rpc } from '@/api/transport';
import type { ItemRef, SourcePin, VodItem } from '@/api/types';

export type { SourcePin };

/** Where older builds kept pins: `{ [matchKey]: { sourceId, itemId, updatedAt } }`. */
export const LEGACY_STORAGE_KEY = 'vod.sourcePins.v1';

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function matchKey(item: Pick<VodItem, 'title' | 'titleBase' | 'year'>): string {
  return `${normalizeTitle(item.titleBase || item.title)}|${item.year ?? ''}`;
}

function readLegacy(): [string, Partial<SourcePin>][] {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? Object.entries(parsed as Record<string, Partial<SourcePin>>) : [];
  } catch {
    return [];
  }
}

function dropLegacy(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // storage unavailable: nothing to drop
  }
}

let migration: Promise<void> | null = null;

/**
 * Moves the pins an older build kept in localStorage into the core, once per page load. A pin
 * the core already has for a key wins, and one whose source is gone is dropped. The local copy is
 * deleted once nothing is left to retry (any other failure keeps it for the next load).
 */
export function migrateLocalPins(): Promise<void> {
  migration ??= (async () => {
    const legacy = readLegacy();
    if (legacy.length === 0) return;
    let retry = false;
    for (const [key, pin] of legacy) {
      if (typeof pin?.sourceId !== 'string' || typeof pin.itemId !== 'string') continue;
      try {
        if (await rpc('sourcePins.get', { matchKey: key })) continue;
        // Only movie pages offered pins.
        await rpc('sourcePins.set', { matchKey: key, ref: { sourceId: pin.sourceId, contentType: 'movie', itemId: pin.itemId } });
      } catch (err) {
        // A source that is gone (not_found) or a key the core refuses (invalid) never lands.
        const { code } = RpcError.from(err);
        if (code !== 'not_found' && code !== 'invalid') retry = true;
      }
    }
    if (!retry) dropLegacy();
  })();
  return migration;
}

/** Test hook: forget that this page load already migrated. */
export function resetPinMigration(): void {
  migration = null;
}

export function isPinned(pin: SourcePin | undefined, ref: ItemRef): boolean {
  return !!pin && pin.sourceId === ref.sourceId && pin.itemId === ref.itemId;
}
