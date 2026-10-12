/**
 * Pure builders for `settings.update` patches. Nested objects (tmdb,
 * dashboardRails, remoteControl) are always sent whole so the core never has
 * to deep-merge, and so a partial object can never drop sibling fields.
 */

import type { DashboardRails, RemoteControlSettings, Settings, TmdbSettings } from '@/api/types';

import { checkHttpUrl } from '../../sources/lib/validate';

/**
 * `tmdb` as sent. The core applies patches as RFC 7396 merge patches, so a
 * field left out keeps the stored value; `null` is how a field is cleared.
 */
export type TmdbPatch = { enabled: boolean; apiKey?: string | null; language?: string | null };

/** `Partial<Settings>` plus the fix-wave-1 fields, with a clearable `tmdb`. */
export type SettingsPatch = Omit<Partial<Settings>, 'tmdb'> & { tmdb?: TmdbPatch } & Partial<ParitySettings>;

/**
 * Settings fields added in fix wave 1 (fixwave1-common.md). Typed here so the UI
 * compiles before and after they land in `Settings`; `parity()` fills defaults.
 */
export interface ParitySettings {
  stripCountryPrefix: boolean;
  epgOffsetMinutes: number;
  playerReuseInstance: boolean;
  showExternalBar: boolean;
  vodMinRating: number;
  recordingsDir: string | null;
}

export function railsPatch(s: Settings, key: keyof DashboardRails, value: boolean): SettingsPatch {
  return { dashboardRails: { ...s.dashboardRails, [key]: value } };
}

/**
 * The whole `tmdb` object with `partial` applied. An empty key ("use .env")
 * or language ("automatic") is sent as `null`: leaving it out would keep the
 * stored value. In server mode `s.tmdb.apiKey` is the mask ("••••" plus the
 * last 4); sent back unchanged, the core ignores it and keeps the real key.
 */
export function tmdbPatch(s: Settings, partial: Partial<TmdbSettings>): SettingsPatch {
  const next: TmdbPatch = { ...s.tmdb, ...partial };
  if (typeof next.apiKey === 'string' && next.apiKey.trim() === '') next.apiKey = null;
  if (typeof next.language === 'string' && next.language.trim() === '') next.language = null;
  return { tmdb: next };
}

/** The settings shape of a sent `tmdb` patch: cleared fields are absent. */
function tmdbFromPatch(p: TmdbPatch): TmdbSettings {
  return {
    enabled: p.enabled,
    ...(p.apiKey != null ? { apiKey: p.apiKey } : {}),
    ...(p.language != null ? { language: p.language } : {}),
  };
}

export function remotePatch(s: Settings, partial: Partial<RemoteControlSettings>): SettingsPatch {
  return { remoteControl: { ...s.remoteControl, ...partial } };
}

/**
 * Optional path fields. An empty string clears the value: JSON drops
 * `undefined`, and `Partial<Settings>` has no `null`, so "" is the only way to
 * say "unset" through the typed patch. The core treats "" as unset.
 */
export function optionalStringPatch(key: 'mpvPath' | 'vlcPath' | 'downloadsDir', value: string): SettingsPatch {
  return { [key]: value.trim() };
}

/** Applies a patch locally (optimistic cache update). */
export function applyPatch(s: Settings, patch: SettingsPatch): Settings {
  const { tmdb, ...rest } = patch;
  return { ...s, ...rest, ...(tmdb ? { tmdb: tmdbFromPatch(tmdb) } : {}) };
}

/** Restores only the keys a failed patch touched, keeping later successful edits. */
export function revertPatch(current: Settings, before: Settings, patch: SettingsPatch): Settings {
  const out: Settings = { ...current };
  for (const k of Object.keys(patch) as (keyof Settings)[]) {
    (out as unknown as Record<string, unknown>)[k] = before[k];
  }
  return out;
}

/** Guide time shift in minutes: a whole number within +/- 12 hours. */
export function validateEpgOffset(raw: string): { ok: true; minutes: number } | { ok: false; error: string } {
  const v = raw.trim();
  if (!/^[+-]?\d+$/.test(v)) return { ok: false, error: 'errorOffsetNumber' };
  const minutes = Number(v);
  if (minutes < -720 || minutes > 720) return { ok: false, error: 'errorOffsetRange' };
  return { ok: true, minutes };
}

/** Minimum VOD rating, clamped to 0..10 in half steps. */
export function clampRating(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, Math.round(n * 2) / 2));
}

// ---- edge validation (return an i18n key in the `settings` namespace, or null) ----

export function validatePort(raw: string): { ok: true; port: number } | { ok: false; error: string } {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return { ok: false, error: 'errorPortNumber' };
  const port = Number(v);
  if (port < 1024 || port > 65535) return { ok: false, error: 'errorPortRange' };
  return { ok: true, port };
}

/** Shell-style argument string: quotes must balance. */
export function validateArgs(raw: string): string | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    }
  }
  if (quote) return 'errorArgsQuote';
  if (/[\r\n]/.test(raw)) return 'errorArgsNewline';
  return null;
}

export function validateHttpUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  return checkHttpUrl(raw);
}

/** Validates and appends a global EPG URL. */
export function addEpgUrl(list: readonly string[], raw: string): { ok: true; list: string[] } | { ok: false; error: string } {
  const r = validateHttpUrl(raw);
  if (!r.ok) return r;
  if (list.includes(r.url)) return { ok: false, error: 'errorEpgDuplicate' };
  return { ok: true, list: [...list, r.url] };
}

/** Executable path: no newlines, no wrapping quotes (users paste "C:\...\mpv.exe"). */
export function cleanPath(raw: string): string {
  return raw.trim().replace(/^"(.*)"$/, '$1');
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) return '';
  if (secret.length <= 4) return '••••';
  return `••••${secret.slice(-4)}`;
}

export type PlayerPathStatus = { kind: 'ok' } | { kind: 'fallback'; path: string } | { kind: 'missing' };

function normPath(p: string): string {
  return cleanPath(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * Whether the configured player path is the one the core resolved
 * (`player.capabilities`). The core accepts the file itself or a folder that
 * holds it; otherwise it falls back to detection, or finds nothing.
 */
export function playerPathStatus(configured: string | undefined, resolved: string | undefined): PlayerPathStatus {
  const want = configured ? normPath(configured) : '';
  if (!want) return { kind: 'ok' };
  if (!resolved) return { kind: 'missing' };
  const got = normPath(resolved);
  if (got === want || got.startsWith(`${want}\\`)) return { kind: 'ok' };
  return { kind: 'fallback', path: resolved };
}

/**
 * The keys of `target` that differ from `current`, as a patch: undoing a
 * reset sends only what the reset changed. A key the defaults dropped
 * (an optional path) is cleared with "", the way the typed patch unsets it.
 */
export function diffSettings(current: Settings, target: Settings): SettingsPatch {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
  for (const k of keys) {
    const a = (current as unknown as Record<string, unknown>)[k];
    const b = (target as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out[k] = b === undefined ? (typeof a === 'string' ? '' : null) : b;
  }
  return out as SettingsPatch;
}
