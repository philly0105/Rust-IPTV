/**
 * Series auto-advance: when an episode starts, the player queue (C8) is set to
 * that episode followed by the rest of its season and the whole next season,
 * so the player's own "Up next" (`usePlayerStore.next()`) keeps going after
 * the detail page is gone (mini player, another screen).
 *
 * The manager lives at module level. It follows the player store: when the
 * player moves to another episode of the same series it extends the queue
 * from there, and shortly before an episode ends it re-resolves the next
 * entry, because Stalker `create_link` URLs carry short-lived tokens. Playing
 * anything else ends it.
 */

import { rpc } from '@/api/transport';
import type { Episode, ItemRef, PlaybackPosition, PlayerSource, SeriesDetail, SourceKind } from '@/api/types';
import { sameRef } from '@/api/types';
import { usePlayerStore } from '@/features/player';

import { episodeSubtitle, isResumable } from './format';
import { episodeOrder } from './merge';

export interface EpisodeQueueContext {
  ref: ItemRef;
  sourceKind: SourceKind;
  /** Series title (the player titles every episode with it). */
  title: string;
  posterUrl?: string;
  /** Every episode in play order (`episodeOrder`). */
  order: readonly Episode[];
  /** Saved positions by episode id, so a half-watched next episode resumes. */
  positions?: ReadonlyMap<string, PlaybackPosition>;
}

/** Seconds before the end at which the next entry's URL is fetched again. */
export const REFRESH_LEAD_SECONDS = 90;
/** Parallel `streamUrl` calls while building a queue. */
const RESOLVE_CONCURRENCY = 4;

/** How many upcoming episodes are resolved ahead. Stalker links expire, so only the next one. */
export function lookaheadFor(kind: SourceKind): number {
  return kind === 'stalker' ? 1 : Number.POSITIVE_INFINITY;
}

/**
 * The episodes that follow `currentId`: the rest of its season, then every
 * episode of the next season. A regular season never runs on into the
 * specials (season 0), which `episodeOrder` puts last. Pure; exported for tests.
 */
export function queueEpisodes(order: readonly Episode[], currentId: string, limit = Number.POSITIVE_INFINITY): Episode[] {
  const i = order.findIndex((e) => e.id === currentId);
  const current = order[i];
  if (!current) return [];
  const out: Episode[] = [];
  let nextSeason: number | undefined;
  for (const ep of order.slice(i + 1)) {
    if (ep.season === current.season) {
      out.push(ep);
      continue;
    }
    if (nextSeason === undefined) {
      if (ep.season <= 0 && current.season > 0) break;
      nextSeason = ep.season;
    }
    if (ep.season !== nextSeason) break;
    out.push(ep);
  }
  return Number.isFinite(limit) ? out.slice(0, Math.max(0, limit)) : out;
}

/**
 * The episodes before `currentId` that Prev walks back through: the earlier
 * episodes of its season, or, from a season's first episode, the previous
 * season's last one. Specials (season 0, sorted last) never lead back into a
 * regular season. Pure; exported for tests.
 */
export function previousEpisodes(order: readonly Episode[], currentId: string): Episode[] {
  const i = order.findIndex((e) => e.id === currentId);
  const current = order[i];
  if (!current) return [];
  const sameSeason = order.slice(0, i).filter((e) => e.season === current.season);
  if (sameSeason.length > 0) return sameSeason;
  const before = order[i - 1];
  return before && (before.season > 0) === (current.season > 0) ? [before] : [];
}

/**
 * Queue entry with no URL yet: the player resolves it (and its saved
 * position) only if it is played, so going back never uses a stale link.
 */
export function placeholderFor(ctx: EpisodeQueueContext, ep: Episode): PlayerSource {
  const out: PlayerSource = {
    url: '',
    kind: 'direct',
    title: ctx.title,
    subtitle: episodeSubtitle(ep.season, ep.episode, ep.title),
    ref: ctx.ref,
    episodeId: ep.id,
    isLive: false,
    isRadio: false,
  };
  if (ctx.posterUrl) out.posterUrl = ctx.posterUrl;
  return out;
}

function streamCommand(kind: SourceKind): 'xtream.streamUrl' | 'stalker.streamUrl' | 'm3u.streamUrl' {
  if (kind === 'xtream') return 'xtream.streamUrl';
  if (kind === 'stalker') return 'stalker.streamUrl';
  return 'm3u.streamUrl';
}

/** One queue entry, titled the way the detail page titles a played episode. */
export async function resolveEpisode(ctx: EpisodeQueueContext, ep: Episode): Promise<PlayerSource> {
  const r = await rpc(streamCommand(ctx.sourceKind), { ref: ctx.ref, episodeId: ep.id });
  const out: PlayerSource = {
    url: r.url,
    kind: r.kind,
    title: ctx.title || r.title,
    subtitle: episodeSubtitle(ep.season, ep.episode, ep.title),
    ref: ctx.ref,
    episodeId: ep.id,
    isLive: false,
    isRadio: false,
  };
  if (r.headers) out.headers = r.headers;
  const poster = ctx.posterUrl ?? r.posterUrl;
  if (poster) out.posterUrl = poster;
  const pos = ctx.positions?.get(ep.id);
  if (typeof r.resumeSeconds === 'number' && r.resumeSeconds > 0) out.resumeSeconds = r.resumeSeconds;
  else if (pos && isResumable(pos)) out.resumeSeconds = pos.positionSeconds;
  return out;
}

/**
 * Resolves episodes in order with a small worker pool. Stops at the first
 * failure: entries after a gap would skip an episode.
 */
export async function resolveQueue(ctx: EpisodeQueueContext, episodes: readonly Episode[]): Promise<PlayerSource[]> {
  const results: (PlayerSource | null)[] = new Array<PlayerSource | null>(episodes.length).fill(null);
  let cursor = 0;
  let failedAt = episodes.length;
  const worker = async () => {
    while (cursor < episodes.length) {
      const i = cursor++;
      if (i >= failedAt) return;
      try {
        results[i] = await resolveEpisode(ctx, episodes[i]!);
      } catch {
        failedAt = Math.min(failedAt, i);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, episodes.length) }, worker));
  const out: PlayerSource[] = [];
  for (let i = 0; i < failedAt; i++) {
    const s = results[i];
    if (!s) break;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

interface ActiveQueue {
  ctx: EpisodeQueueContext;
  /** Episode the queue was last built for. */
  builtFor?: string;
  /** Episode whose next entry was already refreshed near its end. */
  refreshedFor?: string;
  /** Bumped per build/refresh; stale async results compare it. */
  seq: number;
}

let active: ActiveQueue | null = null;
let unsubscribe: (() => void) | null = null;

function currentEpisodeOf(ctx: EpisodeQueueContext): { source: PlayerSource; episodeId: string } | undefined {
  const source = usePlayerStore.getState().source;
  if (!source || !sameRef(source.ref, ctx.ref) || !source.episodeId) return undefined;
  return { source, episodeId: source.episodeId };
}

async function build(a: ActiveQueue, episodeId: string): Promise<void> {
  a.builtFor = episodeId;
  const seq = ++a.seq;
  const upcoming = queueEpisodes(a.ctx.order, episodeId, lookaheadFor(a.ctx.sourceKind));
  const resolved = upcoming.length > 0 ? await resolveQueue(a.ctx, upcoming) : [];
  if (active !== a || a.seq !== seq) return;
  const cur = currentEpisodeOf(a.ctx);
  if (!cur || cur.episodeId !== episodeId) return;
  // Earlier episodes go in front as placeholders, so the player's Prev works from S01E02 on.
  const earlier = previousEpisodes(a.ctx.order, episodeId).map((ep) => placeholderFor(a.ctx, ep));
  usePlayerStore.setState({ queue: [...earlier, cur.source, ...resolved] });
}

async function refreshNext(a: ActiveQueue, episodeId: string): Promise<void> {
  a.refreshedFor = episodeId;
  const queue = usePlayerStore.getState().queue ?? [];
  const idx = queue.findIndex((q) => sameRef(q.ref, a.ctx.ref) && q.episodeId === episodeId);
  const stale = idx >= 0 ? queue[idx + 1] : undefined;
  const ep = stale?.episodeId ? a.ctx.order.find((e) => e.id === stale.episodeId) : undefined;
  if (!ep) return;
  let fresh: PlayerSource;
  try {
    fresh = await resolveEpisode(a.ctx, ep);
  } catch {
    return; // keep the older link; the player reports it if it no longer plays
  }
  if (active !== a) return;
  const now = usePlayerStore.getState().queue ?? [];
  const at = now.findIndex((q) => sameRef(q.ref, a.ctx.ref) && q.episodeId === ep.id);
  if (at < 0) return;
  const next = [...now];
  next[at] = fresh;
  usePlayerStore.setState({ queue: next });
}

function onPlayerChange(): void {
  const a = active;
  if (!a) return;
  const s = usePlayerStore.getState();
  if (!s.source) {
    stopEpisodeQueue();
    return;
  }
  // Something else is playing (a movie, a channel, another series): this queue is over.
  if (!sameRef(s.source.ref, a.ctx.ref)) {
    stopEpisodeQueue();
    return;
  }
  const id = s.source.episodeId;
  if (!id || !a.ctx.order.some((e) => e.id === id)) return;
  if (id !== a.builtFor && s.status !== 'loading') {
    void build(a, id);
    return;
  }
  const dur = s.durationSeconds;
  if (dur && Number.isFinite(dur) && dur > REFRESH_LEAD_SECONDS && s.positionSeconds >= dur - REFRESH_LEAD_SECONDS && a.refreshedFor !== id) {
    void refreshNext(a, id);
  }
}

/**
 * Starts managing the queue for a series whose episode `episodeId` is now the
 * player's source. Call after `playItem` resolved; a no-op when the player
 * is on something else (playback failed or was replaced meanwhile).
 */
export function startEpisodeQueue(ctx: EpisodeQueueContext, episodeId: string): Promise<void> {
  const cur = currentEpisodeOf(ctx);
  if (!cur || cur.episodeId !== episodeId) return Promise.resolve();
  const a: ActiveQueue = { ctx, seq: 0 };
  active = a;
  unsubscribe ??= usePlayerStore.subscribe(onPlayerChange);
  return build(a, episodeId);
}

/** Stops following the player (the queue already set stays as it is). */
export function stopEpisodeQueue(): void {
  active = null;
  unsubscribe?.();
  unsubscribe = null;
}

/** Test hook. */
export function episodeQueueActive(): boolean {
  return active !== null;
}

/**
 * For callers outside the detail page (continue watching, recent): loads the
 * series' episodes and starts the queue for `episodeId`. Errors are swallowed:
 * without a queue the episode still plays, it just does not auto-advance.
 */
export async function queueSeriesFrom(args: {
  ref: ItemRef;
  sourceKind: SourceKind;
  title: string;
  posterUrl?: string;
  episodeId: string;
}): Promise<void> {
  const cmd = args.sourceKind === 'stalker' ? 'stalker.seriesDetail' : args.sourceKind === 'xtream' ? 'xtream.seriesDetail' : 'm3u.seriesDetail';
  try {
    const detail: SeriesDetail = await rpc(cmd, { ref: args.ref });
    const ctx: EpisodeQueueContext = { ref: args.ref, sourceKind: args.sourceKind, title: args.title, order: episodeOrder(detail.seasons) };
    if (args.posterUrl) ctx.posterUrl = args.posterUrl;
    await startEpisodeQueue(ctx, args.episodeId);
  } catch {
    // no queue: the episode plays on its own
  }
}
