/**
 * VOD auto-failover (`settings.vodAutoFailover`): when a movie fails fatally, look for
 * the same title on another source (`catalog.sameTitle`) and switch once.
 * The caller shows an undo toast; undo replays the original source.
 */

import { rpc } from '@/api/transport';
import { itemKey, type PlayerSource } from '@/api/types';

import { getSettings, MIN_RESUME_SECONDS, resolveSource, sameSource, sourceKindOf, usePlayerStore } from './store';

const attempted = new Set<string>();

export interface FailoverResult {
  sourceName: string;
  to: PlayerSource;
  undo(): void;
}

export async function tryFailover(failed: PlayerSource): Promise<FailoverResult | null> {
  const ref = failed.ref;
  if (!ref || failed.isLive || ref.contentType !== 'movie') return null;
  const settings = await getSettings();
  if (!settings?.vodAutoFailover) return null;
  const key = itemKey(ref);
  if (attempted.has(key)) return null;
  attempted.add(key);

  let candidates;
  try {
    // Stalker VOD is paged live from the portal, not stored in the local catalog, so the core's
    // same-title lookup answers not_found (a console resource error in the browser). Only a
    // known source that is not Stalker is asked, as on the movie page.
    if ((await sourceKindOf(ref.sourceId)) === 'stalker') return null;
    candidates = await rpc('catalog.sameTitle', { ref });
  } catch {
    return null;
  }
  const alt =
    candidates.find((c) => c.ref.sourceId !== ref.sourceId && !attempted.has(itemKey(c.ref))) ??
    candidates.find((c) => c.ref.itemId !== ref.itemId && !attempted.has(itemKey(c.ref)));
  if (!alt) return null;

  // The user may have moved on while we looked.
  if (!sameSource(usePlayerStore.getState().source, failed)) return null;

  try {
    const info = await rpc('sources.get', { id: alt.ref.sourceId });
    const position = usePlayerStore.getState().positionSeconds;
    const args: Parameters<typeof resolveSource>[0] = {
      ref: alt.ref,
      title: alt.title,
      isLive: false,
      sourceKind: info.kind,
    };
    const poster = alt.posterUrl ?? failed.posterUrl;
    if (poster) args.posterUrl = poster;
    const resolved = await resolveSource(args);
    if (!sameSource(usePlayerStore.getState().source, failed)) return null;
    attempted.add(itemKey(alt.ref));
    const to: PlayerSource = position > MIN_RESUME_SECONDS ? { ...resolved, resumeSeconds: position } : resolved;
    await usePlayerStore.getState().play(to);
    return {
      sourceName: info.name,
      to,
      undo: () => {
        const back: PlayerSource = { ...failed };
        const pos = usePlayerStore.getState().positionSeconds;
        if (pos > MIN_RESUME_SECONDS) back.resumeSeconds = pos;
        void usePlayerStore.getState().play(back);
      },
    };
  } catch {
    return null;
  }
}

/** Testing only. */
export function __resetFailover(): void {
  attempted.clear();
}
