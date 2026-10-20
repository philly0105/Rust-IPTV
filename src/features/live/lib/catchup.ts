import type { Channel } from '@/api/types';

/**
 * M3U catch-up (Kodi IPTV Simple conventions, also used by the old app's `catchup.utils.ts`).
 *
 * `#EXTINF` attributes `catchup`, `catchup-days` and `catchup-source` arrive on channel rows as
 * `catchup: { type, days?, source? }`. Times in templates are UTC.
 *
 * - `default`: `catchup-source` is the full archive URL template (a relative source is appended,
 *   as most lists mean `?utc={utc}`); without a source it behaves like `shift`.
 * - `append`: `catchup-source` is appended to the live URL.
 * - `shift` / `timeshift` (and an archive with no `catchup` type): `?utc=<start>&lutc=<now>`.
 * - `xc`: Xtream Codes timeshift path built from the live URL.
 * - `flussonic` / `flussonic-hls` / `flussonic-ts` / `fs`: Flussonic archive URL built from the live URL.
 */
export interface CatchupInfo {
  type: string;
  days?: number;
  source?: string;
}

/** Channel row with the M3U catch-up fields (B1-fix3 adds `catchup` to `Channel`). */
export type CatchupChannel = Pick<Channel, 'url' | 'archive'> & { catchup?: CatchupInfo };

export type M3uCatchupMode = 'template' | 'append' | 'shift' | 'xc' | 'flussonic';

export interface CatchupWindow {
  /** Programme start, epoch ms. */
  start: number;
  /** Programme end, epoch ms. */
  end: number;
  /** Wall clock, epoch ms. */
  now: number;
}

const XC_RE = /^(https?:\/\/.+?)\/(?:live\/)?([^/?#]+)\/([^/?#]+)\/([^/?#.]+)(\.[A-Za-z0-9]+)?(\?[^#]*)?$/;
const FLUSSONIC_RE = /^(https?:\/\/[^/]+)\/(.*)\/([^/]*)(mpegts|\.m3u8)(\?[^#]*)?$/;

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Which builder applies to this channel, or `null` when its catch-up cannot be played. */
export function m3uCatchupMode(channel: CatchupChannel | undefined): M3uCatchupMode | null {
  if (!channel?.archive?.enabled) return null;
  const url = channel.url?.trim();
  const source = channel.catchup?.source?.trim();
  const type = channel.catchup?.type?.trim().toLowerCase() ?? '';
  switch (type) {
    case '':
    case 'shift':
    case 'timeshift':
      return isHttpUrl(url) ? 'shift' : null;
    case 'default':
      if (isHttpUrl(source)) return 'template';
      if (source) return isHttpUrl(url) ? 'append' : null;
      return isHttpUrl(url) ? 'shift' : null;
    case 'append':
      return source && isHttpUrl(url) ? 'append' : null;
    case 'xc':
      return url && XC_RE.test(url) ? 'xc' : null;
    case 'flussonic':
    case 'flussonic-hls':
    case 'flussonic-ts':
    case 'fs':
      return url && FLUSSONIC_RE.test(url) ? 'flussonic' : null;
    default:
      return null;
  }
}

export function isM3uCatchupSupported(channel: CatchupChannel | undefined): boolean {
  return m3uCatchupMode(channel) !== null;
}

/** A template token that bounds the archive: its end time or its length. */
const END_TOKEN = /\$?\{(?:utcend|end|duration)(?::[^}]*)?\}/i;

/**
 * True when an M3U channel's archive URL names where the programme ends, so a download of it
 * stops by itself (FW-ARCHIVE-DOWNLOAD-UNBOUNDED). `shift` (`?utc=<start>&lutc=<now>`, the
 * default for a playlist that names no catch-up type) and Flussonic's MPEG-TS
 * `timeshift_abs-<start>.ts` both play on from the start into the live stream: a download of
 * either would never end. Xtream-style paths carry the length; a template or an appended source
 * does when it has an end or duration token.
 */
export function m3uCatchupEnds(channel: CatchupChannel | undefined): boolean {
  switch (m3uCatchupMode(channel)) {
    case 'xc':
      return true;
    case 'template':
    case 'append':
      return END_TOKEN.test(channel?.catchup?.source ?? '');
    case 'flussonic': {
      // The HLS form names its length (`index-<start>-<duration>.m3u8`); the MPEG-TS one does not.
      const m = FLUSSONIC_RE.exec(channel?.url?.trim() ?? '');
      return !!m && m[4] !== 'mpegts';
    }
    default:
      return false;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatUtc(t: number, fmt: string): string {
  const d = new Date(t);
  const parts: Record<string, string> = {
    Y: pad(d.getUTCFullYear(), 4),
    m: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    H: pad(d.getUTCHours()),
    M: pad(d.getUTCMinutes()),
    S: pad(d.getUTCSeconds()),
  };
  return fmt.replace(/[YmdHMS]/g, (c) => parts[c] ?? c);
}

/**
 * Fills Kodi-style catch-up tokens: `{utc}`/`{start}`/`${start}`, `{utcend}`/`{end}`/`${end}`,
 * `{lutc}`/`{now}`/`${now}`/`${timestamp}`, `{duration}` (seconds), `{duration:N}` and
 * `{offset:N}` (seconds divided by N), `{Y}` `{m}` `{d}` `{H}` `{M}` `{S}` (programme start),
 * and `{utc:Y-m-d:H-M}` style formats on any of the time tokens. Unknown tokens stay as written.
 */
export function fillCatchupTemplate(template: string, w: CatchupWindow): string {
  const startS = Math.floor(w.start / 1000);
  const endS = Math.floor(w.end / 1000);
  const nowS = Math.floor(w.now / 1000);
  const times: Record<string, number> = {
    utc: w.start,
    start: w.start,
    utcend: w.end,
    end: w.end,
    lutc: w.now,
    now: w.now,
    timestamp: w.now,
  };
  const seconds: Record<string, number> = {
    utc: startS,
    start: startS,
    utcend: endS,
    end: endS,
    lutc: nowS,
    now: nowS,
    timestamp: nowS,
    duration: Math.max(0, endS - startS),
    offset: Math.max(0, nowS - startS),
  };
  return template.replace(/\$?\{([A-Za-z]+)(?::([^}]*))?\}/g, (whole, name: string, arg: string | undefined) => {
    if (/^[YmdHMS]$/.test(name) && arg === undefined) return formatUtc(w.start, name);
    const key = name.toLowerCase();
    if (key === 'duration' || key === 'offset') {
      const value = seconds[key]!;
      if (arg === undefined) return String(value);
      const unit = Number.parseInt(arg, 10);
      return Number.isFinite(unit) && unit > 0 ? String(Math.floor(value / unit)) : whole;
    }
    if (key in times) return arg === undefined ? String(seconds[key]) : formatUtc(times[key]!, arg);
    return whole;
  });
}

function appendQuery(url: string, query: string): string {
  return url + (url.includes('?') ? '&' : '?') + query;
}

/**
 * Builds the archive URL for an M3U channel and programme, or `null` when the channel's
 * catch-up is not usable.
 */
export function resolveM3uCatchupUrl(channel: CatchupChannel | undefined, w: CatchupWindow): string | null {
  const mode = m3uCatchupMode(channel);
  if (!mode || !channel) return null;
  const url = channel.url?.trim() ?? '';
  const source = channel.catchup?.source?.trim() ?? '';
  const startS = Math.floor(w.start / 1000);
  const durS = Math.max(60, Math.floor((w.end - w.start) / 1000));
  switch (mode) {
    case 'template':
      return fillCatchupTemplate(source, w);
    case 'append': {
      const filled = fillCatchupTemplate(source, w);
      // `?utc=..` on a URL that already has a query joins with `&`.
      if (filled.startsWith('?') && url.includes('?')) return `${url}&${filled.slice(1)}`;
      return url + filled;
    }
    case 'shift':
      return appendQuery(url, `utc=${startS}&lutc=${Math.floor(w.now / 1000)}`);
    case 'xc': {
      const m = XC_RE.exec(url)!;
      const [, base, user, pass, id, ext, query] = m;
      const minutes = Math.max(1, Math.ceil(durS / 60));
      const ts = ext && ext.toLowerCase() === '.m3u8' ? '.m3u8' : '.ts';
      return `${base}/timeshift/${user}/${pass}/${minutes}/${formatUtc(w.start, 'Y-m-d:H-M')}/${id}${ts}${query ?? ''}`;
    }
    case 'flussonic': {
      const m = FLUSSONIC_RE.exec(url)!;
      const [, host, channelId, listType, streamType, query] = m;
      if (streamType === 'mpegts') return `${host}/${channelId}/timeshift_abs-${startS}.ts${query ?? ''}`;
      const list = listType || 'index';
      return `${host}/${channelId}/${list}-${startS}-${durS}.m3u8${query ?? ''}`;
    }
  }
}
