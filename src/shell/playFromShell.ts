/**
 * Playing from Home and the command palette. The player loads on the press (performance audit
 * SH-2), so neither chunk carries it. A series episode also gets the series queue, so the next
 * episode follows on its own, as it does from the detail page and from Recently watched (library
 * resumePosition); without it the player had no Up next and playback stopped after the episode.
 */

export type PlayItemArgs = Parameters<typeof import('@/features/player').playItem>[0];

export async function playFromShell(args: PlayItemArgs): Promise<void> {
  const { playItem } = await import('@/features/player');
  await playItem(args);
  if (args.ref.contentType !== 'series' || !args.episodeId) return;
  // Light (the player is in by now): the series detail is fetched and the queue starts only if
  // this episode is the one playing (a refused PIN leaves what played alone).
  const { queueSeriesFrom } = await import('@/features/vod/lib/episodeQueue');
  await queueSeriesFrom({
    ref: args.ref,
    sourceKind: args.sourceKind,
    title: args.title,
    episodeId: args.episodeId,
    ...(args.posterUrl ? { posterUrl: args.posterUrl } : {}),
  });
}
