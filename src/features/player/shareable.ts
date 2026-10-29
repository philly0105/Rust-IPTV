/**
 * Whether a stream URL may be handed to the user (Copy stream link). Provider logins ride in
 * the URL itself, in more shapes than any list of secret names covers: Xtream puts the
 * username and password in the path (`/live/u/p/1.ts`, `/u/p/1`, `/play/u/p/1.ts`), panels and
 * portals use `u=`/`p=`/`pw=` parameters, play tokens and the box MAC. So this denies by
 * default: a link is shareable only when it has no userinfo, no fragment, only harmless query
 * parameters, and no path that looks like `<user>/<password>/<stream id>`.
 */

import type { PlayerSource, SourceKind } from '@/api/types';

import { redactUrl } from '../sources/lib/redact';
import { knownSourceKind } from './store';

/** Query parameters that never carry a login (compared decoded and lowercased). */
const HARMLESS_PARAMS = new Set([
  'format', 'quality', 'lang', 'language', 'output', 'ext', 'res', 'resolution',
  // Kodi-style catch-up URLs use these to select the programme's archive window.
  'utc', 'lutc', 'utcstart', 'utcend', 'start', 'end', 'duration',
  // iptvcat.com marks the links it has checked.
  'checkedby',
]);
/** A stream id: digits, optionally with an extension (`12345`, `12345.ts`). */
const STREAM_ID = /^\d+(?:\.[a-z0-9]{1,5})?$/i;
/** A Stalker box MAC anywhere in the link. */
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i;
/** Long opaque segments (signed links, JWTs, session ids): letters and digits mixed, 24+ chars. */
const OPAQUE = /^(?=.*\d)(?=.*[a-z])[a-z0-9_~=+-]{24,}$/i;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function isShareableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hash) return false;
  for (const name of parsed.searchParams.keys()) {
    if (!HARMLESS_PARAMS.has(decode(name).trim().toLowerCase())) return false;
  }
  if (MAC.test(decode(url))) return false;
  // Decode the whole path before splitting, so `/u%2Fp%2F123.ts` is three segments.
  const segments = decode(parsed.pathname).split('/').filter(Boolean);
  // `key=value`, `user:pass`, `;jsessionid=`, `user@host` inside a segment.
  if (segments.some((seg) => /[:=;@]/.test(seg))) return false;
  const common = (i: number): boolean => i >= 0 && COMMON_FOLDER.has(segments[i]!.toLowerCase());
  // Akamai's `/hls/live/<event id>/<name>/master.m3u8`: a bare number right below two ordinary
  // folders, where Xtream would have the user and password.
  const cdnId = (i: number): boolean => /^\d+$/.test(segments[i]!) && common(i - 2) && common(i - 1);
  // The redaction rules read `/live/<event id>/<name>/` as an Xtream login; only that `live`
  // folder is left out of the check, every other shape still goes through it.
  const akamai = segments.some((_, i) => cdnId(i) && segments[i - 1]!.toLowerCase() === 'live');
  const checked = akamai ? url.replace(/\/live\/(\d+\/)/i, '/$1') : url;
  if (redactUrl(checked) !== checked) return false;
  // `<user>/<password>/<stream id>` anywhere in the path (root short form, /live/, /play/, ...).
  for (let i = 2; i < segments.length; i++) {
    if (STREAM_ID.test(segments[i]!) && !cdnId(i)) return false;
  }
  // `.../<user>/<password>/<channel>.m3u8`: a named stream below two segments that are not
  // ordinary folder names.
  if (segments.length >= 3) {
    const n = segments.length;
    const safe = (i: number): boolean => common(i) || RESOLUTION.test(segments[i]!) || cdnId(i);
    if (!safe(n - 3) && !safe(n - 2)) return false;
  }
  return !segments.some((seg) => (OPAQUE.test(seg) && !HEX_HASH.test(seg) && !wordy(seg)) || MAC_SEGMENT.test(seg) || hidesLogin(seg));
}

/** A resolution folder (`1080p`, `720p`, `1920x1080`, `4k`). */
const RESOLUTION = /^(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|[248]k)$/i;
/** A lowercase md5/sha1/sha256 hex digest, as hashed CDN folders use (not a login token shape). */
const HEX_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A long name made of words (`amagi_hls_data_xumo1212A-redboxrakuten`): at least three
 * lowercase words of 3+ letters and at most one other part. Random tokens almost never have
 * even one all-lowercase run that long.
 */
function wordy(segment: string): boolean {
  const parts = segment.split(/[_-]+/).filter(Boolean);
  const words = parts.filter((p) => /^[a-z]{3,}$/.test(p)).length;
  return words >= 3 && words >= parts.length - 1;
}

/** Folder names CDNs and playlists use, which a username or password pair would not be. */
const COMMON_FOLDER = new Set([
  'live', 'hls', 'dash', 'vod', 'movie', 'movies', 'series', 'tv', 'shows', 'stream', 'streams', 'channel',
  'channels', 'media', 'video', 'videos', 'audio', 'radio', 'cdn', 'content', 'play', 'playlist', 'playlists',
  'public', 'static', 'files', 'out', 'v1', 'v2', 'hd', 'sd', 'fhd', 'uhd', '4k', 'news', 'sports', 'kids',
  'examples', 'samples', 'streaming',
]);

/** A box MAC written without separators (`001A79000001`). */
const MAC_SEGMENT = /^[0-9a-f]{12}(?:\.[a-z0-9]{1,5})?$/i;

/** A segment that is base64 for `user:pass` or `user@host` (`dXNlcjpwYXNz.m3u8`). */
function hidesLogin(segment: string): boolean {
  const stem = segment.replace(/\.[a-z0-9]{1,5}$/i, '');
  if (stem.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(stem)) return false;
  try {
    const text = atob(stem.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(stem.length / 4) * 4, '='));
    return /^[\x20-\x7e]+$/.test(text) && /[:@]/.test(text);
  } catch {
    return false;
  }
}

/**
 * True when Copy stream link may show for `source`: a plain playlist (M3U) item or a direct
 * link that carries no credentials. `kindOf` reports the source's kind when this session knows
 * it; Xtream and Stalker links are logins, and an unknown kind could be either.
 */
export function canShareSource(
  source: PlayerSource,
  kindOf: (sourceId: string) => SourceKind | undefined = knownSourceKind,
  options: { allowCredentials?: boolean } = {},
): boolean {
  // Programme archive links are an explicit user action and may need the provider login in their
  // path (Xtream/Stalker timeshift). Keep the basic URL checks, but do not apply the normal
  // shareability/redaction policy used for ordinary channel links.
  if (options.allowCredentials) {
    try {
      const parsed = new URL(source.url);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.hash;
    } catch {
      return false;
    }
  }
  if (source.ref && kindOf(source.ref.sourceId) !== 'm3u') return false;
  return isShareableUrl(source.url);
}
