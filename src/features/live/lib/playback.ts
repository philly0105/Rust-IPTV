import type { DownloadStartArgs } from '@/api/rpc';
import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, PlayerKind, PlayerSource, RequestHeaders, Source, SourceKind } from '@/api/types';

import { playItem, playSource } from '@/features/player';
import { parseClearKey } from '@/features/player/clearKey';
// The gate module itself, not the parental barrel (which pulls in the settings section and dialogs).
import { ensureUnlocked } from '@/features/parental/gate';
import { type CatchupChannel, resolveM3uCatchupUrl } from './catchup';
import { durationMinutes, ms } from './epgTime';

function guessKind(url: string): PlayerKind {
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'direct';
}

/** Per-channel `#EXTVLCOPT` headers over the playlist's; undefined when none is set. */
function mergeHeaders(sourceHeaders: RequestHeaders | undefined, channelHeaders: RequestHeaders | undefined): RequestHeaders | undefined {
  const headers = { ...sourceHeaders, ...channelHeaders };
  return Object.values(headers).some(Boolean) ? headers : undefined;
}

/**
 * Resolves a playable source for a channel without starting playback (external player, copy URL).
 * `displayName` is the name the live views show (`settings.stripCountryPrefix`); it titles the player.
 */
export async function resolveChannelSource(
  channel: Channel,
  source: Pick<Source, 'kind' | 'm3u'>,
  displayName: string = channel.name,
): Promise<PlayerSource> {
  const base = { title: displayName || channel.name, posterUrl: channel.logoUrl, isLive: true, isRadio: channel.isRadio };
  if (source.kind === 'xtream') return { ...(await rpc('xtream.streamUrl', { ref: channel.ref })), ...base };
  if (source.kind === 'stalker') return { ...(await rpc('stalker.streamUrl', { ref: channel.ref })), ...base };
  let url = channel.url;
  let channelHeaders = channel.headers;
  if (!url) {
    const item = (await rpc('catalog.item', { ref: channel.ref })) as Channel;
    url = item.url;
    channelHeaders = item.headers ?? channelHeaders;
  }
  if (!url) throw new Error('This channel has no stream address.');
  const out: PlayerSource = { ...base, url, kind: guessKind(url), ref: channel.ref };
  // Same merge as inline playback: per-channel `#EXTVLCOPT` headers override the playlist's.
  const headers = mergeHeaders(source.m3u?.headers, channelHeaders);
  if (headers) out.headers = headers;
  return out;
}

/**
 * The channel's playable source for use outside the built-in player (an external player, a copied
 * link), behind the parental gate (C2): in Ask mode a channel or group that is locked asks for the
 * PIN first, exactly like inline playback. Resolves null when the prompt was cancelled or the lock
 * check failed (the gate fails closed and reports why); nothing is resolved or opened then.
 */
export async function openChannelSource(
  channel: Channel,
  source: Pick<Source, 'kind' | 'm3u'>,
  displayName: string = channel.name,
): Promise<PlayerSource | null> {
  const allowed = await ensureUnlocked([
    { ref: channel.ref, title: displayName || channel.name, ...(channel.categoryId ? { categoryId: channel.categoryId } : {}) },
  ]);
  if (!allowed) return null;
  return resolveChannelSource(channel, source, displayName);
}

/**
 * `displayName`: the name the live views show (`settings.stripCountryPrefix`); it titles the player and history.
 * The row goes along, so an M3U channel with its URL plays without a `catalog.item` lookup.
 */
export function playChannel(channel: Channel, kind: SourceKind, nowTitle?: string, displayName: string = channel.name): Promise<void> {
  return playItem({
    ref: channel.ref,
    title: displayName || channel.name,
    subtitle: nowTitle,
    posterUrl: channel.logoUrl,
    isLive: true,
    isRadio: channel.isRadio,
    sourceKind: kind,
    // The parental gate checks group locks with it (C2).
    ...(channel.categoryId ? { categoryId: channel.categoryId } : {}),
    channel,
  });
}

/** Archive source for an M3U channel, built from its `catchup` attributes. */
export function m3uCatchupSource(channel: Channel, program: EpgProgram, now: number, sourceHeaders?: RequestHeaders): PlayerSource {
  const url = resolveM3uCatchupUrl(channel as Channel & CatchupChannel, { start: ms(program.start), end: ms(program.end), now });
  if (!url) throw new Error('This channel has no usable catch-up address.');
  const out: PlayerSource = { url, kind: guessKind(url), title: channel.name, ref: channel.ref, isLive: false, isRadio: false };
  const headers = mergeHeaders(sourceHeaders, channel.headers);
  if (headers) out.headers = headers;
  // A ClearKey channel's archive is encrypted with the same keys.
  const drm = parseClearKey(channel.clearKey);
  if (drm) out.drm = drm;
  return out;
}

/** The archive source of a programme: the portal's timeshift link, or the M3U `catchup` URL. */
export async function catchupSource(channel: Channel, kind: SourceKind, program: EpgProgram, now = Date.now()): Promise<PlayerSource> {
  const args = { ref: channel.ref, start: program.start, durationMinutes: durationMinutes(program) };
  if (kind === 'xtream') return rpc('xtream.catchupUrl', args);
  if (kind === 'stalker') return rpc('stalker.catchupUrl', args);
  if (kind === 'm3u') {
    const [item, source] = await Promise.all([
      channel.url ? channel : (rpc('catalog.item', { ref: channel.ref }) as Promise<Channel>),
      rpc('sources.get', { id: channel.ref.sourceId }).catch(() => null),
    ]);
    return m3uCatchupSource(item, program, now, source?.m3u?.headers);
  }
  throw new Error('Catch-up is not available for this source.');
}

/**
 * Plays an archived programme: the portal's timeshift link, or the M3U `catchup` URL.
 * `displayName` (the name the live views show) titles the player when given.
 */
export async function playCatchup(
  channel: Channel,
  kind: SourceKind,
  program: EpgProgram,
  now = Date.now(),
  displayName?: string,
): Promise<void> {
  const src = await catchupSource(channel, kind, program, now);
  await playSource({
    ...src,
    title: displayName || src.title || channel.name,
    subtitle: program.title,
    posterUrl: src.posterUrl ?? channel.logoUrl,
    ref: src.ref ?? channel.ref,
    isLive: false,
    isRadio: false,
  });
}

/** File extensions an archive download keeps from its URL; anything else (`.php`, none) saves as MPEG-TS. */
const ARCHIVE_EXTENSIONS = new Set(['ts', 'mp4', 'mkv', 'avi', 'mov']);

/**
 * `downloads.start` args for an archived programme, behind the parental gate (C2) like playback;
 * null when the prompt was cancelled. The row is the channel's ref with episode id
 * `catchup:<start>`, so each programme is its own download and My Videos groups them under the
 * channel; the core keeps the archive URL instead of re-resolving it. An HLS or DASH archive is a
 * playlist, not one file, and is refused with `notFileMessage`.
 */
export async function catchupDownloadArgs(
  channel: Channel,
  kind: SourceKind,
  program: EpgProgram,
  opts: { now?: number; displayName?: string; subtitle: string; notFileMessage: string },
): Promise<DownloadStartArgs | null> {
  const title = opts.displayName || channel.name;
  const allowed = await ensureUnlocked([{ ref: channel.ref, title, ...(channel.categoryId ? { categoryId: channel.categoryId } : {}) }]);
  if (!allowed) return null;
  const src = await catchupSource(channel, kind, program, opts.now);
  if (src.kind === 'hls' || src.kind === 'dash') throw new Error(opts.notFileMessage);
  const urlExt = /\.([a-z0-9]{2,4})$/i.exec(src.url.split(/[?#]/)[0] ?? '')?.[1]?.toLowerCase();
  const ext = urlExt && ARCHIVE_EXTENSIONS.has(urlExt) ? urlExt : 'ts';
  const args: DownloadStartArgs = {
    ref: channel.ref,
    episodeId: `catchup:${program.start}`,
    title,
    subtitle: opts.subtitle,
    url: src.url,
    fileNameHint: `${title} - ${opts.subtitle.replace(/\s*·\s*/g, ' - ')}.${ext}`,
  };
  if (src.headers) args.headers = src.headers;
  if (channel.logoUrl) args.posterUrl = channel.logoUrl;
  return args;
}
