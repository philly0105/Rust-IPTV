import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, PlayerKind, PlayerSource, RequestHeaders, Source, SourceKind } from '@/api/types';

import { playItem, playSource } from '@/features/player';
import { type CatchupChannel, resolveM3uCatchupUrl } from './catchup';
import { durationMinutes, ms } from './epgTime';

function guessKind(url: string): PlayerKind {
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'direct';
}

/** Resolves a playable source for a channel without starting playback (external player, copy URL). */
export async function resolveChannelSource(channel: Channel, source: Pick<Source, 'kind' | 'm3u'>): Promise<PlayerSource> {
  const base = { title: channel.name, posterUrl: channel.logoUrl, isLive: true, isRadio: channel.isRadio };
  if (source.kind === 'xtream') return { ...(await rpc('xtream.streamUrl', { ref: channel.ref })), ...base };
  if (source.kind === 'stalker') return { ...(await rpc('stalker.streamUrl', { ref: channel.ref })), ...base };
  let url = channel.url;
  if (!url) {
    const item = (await rpc('catalog.item', { ref: channel.ref })) as Channel;
    url = item.url;
  }
  if (!url) throw new Error('This channel has no stream address.');
  return { ...base, url, kind: guessKind(url), headers: source.m3u?.headers, ref: channel.ref };
}

export function playChannel(channel: Channel, kind: SourceKind, nowTitle?: string): Promise<void> {
  return playItem({
    ref: channel.ref,
    title: channel.name,
    subtitle: nowTitle,
    posterUrl: channel.logoUrl,
    isLive: true,
    isRadio: channel.isRadio,
    sourceKind: kind,
  });
}

/** Archive source for an M3U channel, built from its `catchup` attributes. */
export function m3uCatchupSource(channel: Channel, program: EpgProgram, now: number, sourceHeaders?: RequestHeaders): PlayerSource {
  const url = resolveM3uCatchupUrl(channel as Channel & CatchupChannel, { start: ms(program.start), end: ms(program.end), now });
  if (!url) throw new Error('This channel has no usable catch-up address.');
  const out: PlayerSource = { url, kind: guessKind(url), title: channel.name, ref: channel.ref, isLive: false, isRadio: false };
  // Per-channel `#EXTVLCOPT` headers override the playlist's.
  const headers = { ...sourceHeaders, ...(channel as Channel & { headers?: RequestHeaders }).headers };
  if (Object.values(headers).some(Boolean)) out.headers = headers;
  return out;
}

/** Plays an archived programme: the portal's timeshift link, or the M3U `catchup` URL. */
export async function playCatchup(channel: Channel, kind: SourceKind, program: EpgProgram, now = Date.now()): Promise<void> {
  const args = { ref: channel.ref, start: program.start, durationMinutes: durationMinutes(program) };
  let src: PlayerSource;
  if (kind === 'xtream') {
    src = await rpc('xtream.catchupUrl', args);
  } else if (kind === 'stalker') {
    src = await rpc('stalker.catchupUrl', args);
  } else if (kind === 'm3u') {
    const [item, source] = await Promise.all([
      channel.url ? channel : (rpc('catalog.item', { ref: channel.ref }) as Promise<Channel>),
      rpc('sources.get', { id: channel.ref.sourceId }).catch(() => null),
    ]);
    src = m3uCatchupSource(item, program, now, source?.m3u?.headers);
  } else {
    throw new Error('Catch-up is not available for this source.');
  }
  await playSource({
    ...src,
    title: src.title || channel.name,
    subtitle: program.title,
    posterUrl: src.posterUrl ?? channel.logoUrl,
    ref: src.ref ?? channel.ref,
    isLive: false,
    isRadio: false,
  });
}
