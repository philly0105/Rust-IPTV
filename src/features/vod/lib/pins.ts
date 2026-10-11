/**
 * Preferred-source pins for multi-source VOD ("Other sources").
 *
 * The schema has a `vod_source_pins` table (C3) but C4 exposes no rpc for it,
 * so pins are kept in localStorage under the same match key the table uses
 * until a `catalog.pin*` command exists (reported to the integration agent).
 * The match key mirrors the server's same-title rule: normalized title base
 * plus year.
 */

import type { ItemRef, VodItem } from '@/api/types';

const STORAGE_KEY = 'vod.sourcePins.v1';

export interface SourcePin {
  sourceId: string;
  itemId: string;
  updatedAt: string;
}

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

function readAll(): Record<string, SourcePin> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, SourcePin>) : {};
  } catch {
    return {};
  }
}

function writeAll(pins: Record<string, SourcePin>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // storage full or unavailable: pins are a convenience, not state we must keep
  }
}

export function getPin(key: string): SourcePin | undefined {
  return readAll()[key];
}

export function setPin(key: string, ref: ItemRef): SourcePin {
  const pins = readAll();
  const pin: SourcePin = { sourceId: ref.sourceId, itemId: ref.itemId, updatedAt: new Date().toISOString() };
  pins[key] = pin;
  writeAll(pins);
  return pin;
}

export function clearPin(key: string): void {
  const pins = readAll();
  delete pins[key];
  writeAll(pins);
}

export function isPinned(pin: SourcePin | undefined, ref: ItemRef): boolean {
  return !!pin && pin.sourceId === ref.sourceId && pin.itemId === ref.itemId;
}
