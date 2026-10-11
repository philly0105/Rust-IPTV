import { rpc } from '@/api/transport';
import type { Channel, EpgProgram, PlayerKind, PlayerSource, Source, SourceKind } from '@/api/types';

import { playItem, playSource } from '../_shim';
import { durationMinutes } from './epgTime';

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

/** Plays an archived programme through the portal's timeshift link. */
export async function playCatchup(channel: Channel, kind: SourceKind, program: EpgProgram): Promise<void> {
  const args = { ref: channel.ref, start: program.start, durationMinutes: durationMinutes(program) };
  let src: PlayerSource;
  if (kind === 'xtream') src = await rpc('xtream.catchupUrl', args);
  else if (kind === 'stalker') src = await rpc('stalker.catchupUrl', args);
  else throw new Error('Catch-up is available for Xtream and Stalker sources only.');
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
