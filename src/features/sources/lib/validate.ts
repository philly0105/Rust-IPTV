/**
 * Edge validation for source forms. Every function is pure and returns either
 * a normalized value or an i18n key (namespace `sources`) describing the problem.
 */

import { REDACTED, redactUrl } from './redact';

/** Infomir's OUI. The stock Stalker MAC filter only accepts this range. */
export const INFOMIR_MAC_OUI = '00:1A:79';

const MAC_SEPARATORS = /[\s:.-]/g;
const TWELVE_HEX = /^[0-9A-F]{12}$/;

/**
 * Canonical uppercase colon form (`00:1A:79:12:34:56`) or null when the input
 * is not a MAC. Accepts colons, hyphens, dots, spaces, or no separator.
 */
export function normalizeMac(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(MAC_SEPARATORS, '').toUpperCase();
  if (!TWELVE_HEX.test(digits)) return null;
  return (digits.match(/.{2}/g) ?? []).join(':');
}

/**
 * Formats a MAC while the user types: keeps hex digits only, uppercases, and
 * inserts colons every two digits. Caps at 12 digits.
 */
export function formatMacInput(value: string): string {
  const digits = value
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
    .slice(0, 12);
  return (digits.match(/.{1,2}/g) ?? []).join(':');
}

/** True when the MAC sits in Infomir's OUI. A false result is a hint, not an error. */
export function hasInfomirOui(value: string | null | undefined): boolean {
  const mac = normalizeMac(value);
  return mac !== null && mac.startsWith(`${INFOMIR_MAC_OUI}:`);
}

/** Portal URLs that point at a full Ministra/Stalker install (handshake + token). */
export function looksLikeFullPortal(url: string): boolean {
  return url.includes('/stalker_portal') || url.includes('/server/load.php');
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Accepts http(s) URLs only; trims; adds `http://` when the scheme is missing. */
export function checkHttpUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'errorRequired' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: 'errorUrlInvalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'errorUrlScheme' };
  if (!parsed.hostname) return { ok: false, error: 'errorUrlInvalid' };
  return { ok: true, url: withScheme };
}

/**
 * Xtream server URL: scheme + host + optional port + optional path prefix,
 * with `player_api.php`, `get.php` and query strings removed.
 */
export function normalizeXtreamServer(raw: string): UrlCheck {
  const check = checkHttpUrl(raw);
  if (!check.ok) return check;
  const u = new URL(check.url);
  // Assigning '' to u.pathname would come back as '/', so build the string directly.
  const path = u.pathname.replace(/\/(player_api|get|xmltv)\.php$/i, '').replace(/\/+$/, '');
  return { ok: true, url: `${u.origin}${path}` };
}

/**
 * Recognizes an Xtream `get.php?username=&password=` playlist link so the add
 * dialog can offer the richer Xtream import instead of plain M3U.
 */
export function parseXtreamLink(raw: string): { serverUrl: string; username: string; password: string } | null {
  const check = checkHttpUrl(raw);
  if (!check.ok) return null;
  const u = new URL(check.url);
  if (!/\/(get|player_api)\.php$/i.test(u.pathname)) return null;
  const username = u.searchParams.get('username');
  const password = u.searchParams.get('password');
  if (!username || !password) return null;
  const server = normalizeXtreamServer(check.url);
  if (!server.ok) return null;
  return { serverUrl: server.url, username, password };
}

/** Header values must be single-line printable text. */
export function checkHeaderValue(value: string): string | null {
  if (!value) return null;
  return /[\r\n\u0000-\u001f]/.test(value) ? 'errorHeaderValue' : null;
}

/** Origin header must be a bare origin (`https://host[:port]`). */
export function checkOrigin(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'errorOrigin';
    if (u.pathname !== '/' || u.search || u.hash) return 'errorOrigin';
    return null;
  } catch {
    return 'errorOrigin';
  }
}

/**
 * Last path parts that say nothing about the source: playlist and Xtream endpoints, and the
 * stock Stalker/Ministra portal paths (`/c/`, `/stalker_portal/`, `/portal.php`, `/server/load.php`).
 */
const GENERIC_STEM = /^(get|playlist|index|player_api|c|stalker_portal|portal|server|load|panel)$/i;

/** Derives a readable default name from a URL or file path. */
export function suggestName(input: string): string {
  const v = input.trim();
  if (!v) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const stem = safeDecode(last).replace(/\.(m3u8?|php|txt)$/i, '');
    if (stem && !GENERIC_STEM.test(stem)) return stem;
    return u.hostname.replace(/^www\./, '');
  } catch {
    const file = v.split(/[\\/]/).pop() ?? v;
    return file.replace(/\.(m3u8?|txt)$/i, '');
  }
}

/** `decodeURIComponent` that keeps the raw text when it holds a broken escape (`%E0%A4`). */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Host part of a URL for display, without credentials. Text that does not parse
 * as a URL is shown with any userinfo, secret parameters or Xtream path removed.
 */
export function displayHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return redactUrl(url).replace(/^[^@/]*@/, `${REDACTED}@`);
  }
}

/**
 * A password with a leading or trailing space, the usual leftover of copying it from an email.
 * Not an error (spaces can be real), so the form only hints at it.
 */
export function hasEdgeSpace(value: string): boolean {
  return value.length > 0 && value !== value.trim();
}
