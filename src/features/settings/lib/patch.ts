/**
 * Pure builders for `settings.update` patches. Nested objects (tmdb,
 * dashboardRails, remoteControl) are always sent whole so the core never has
 * to deep-merge, and so a partial object can never drop sibling fields.
 */

import type { DashboardRails, RemoteControlSettings, Settings, TmdbSettings } from '@/api/types';

import { checkHttpUrl } from '../../sources/lib/validate';

/** `Partial<Settings>` plus the fix-wave-1 fields. */
export type SettingsPatch = Partial<Settings> & Partial<ParitySettings>;

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

export function tmdbPatch(s: Settings, partial: Partial<TmdbSettings>): SettingsPatch {
  const next: TmdbSettings = { ...s.tmdb, ...partial };
  // An empty key means "use .env"; omit it rather than storing "".
  if (next.apiKey !== undefined && next.apiKey.trim() === '') delete next.apiKey;
  if (next.language !== undefined && next.language.trim() === '') delete next.language;
  return { tmdb: next };
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
  return { ...s, ...patch };
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
