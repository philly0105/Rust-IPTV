/**
 * Writes the onboarding markers (`tourCompleted`, `lastSeenVersion`). The
 * cache changes at once, so the startup decision moves on without waiting
 * for the core; the core's answer then refreshes only these keys, so an
 * unrelated settings edit in flight is never overwritten. A failure is not
 * shown: the markers are retried at the next start, and the host remembers
 * what it already showed this session, so nothing reopens in a loop.
 */

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Settings } from '@/api/types';

export type OnboardingPatch = Partial<Pick<Settings, 'tourCompleted' | 'lastSeenVersion'>>;

const KEY = rpcKey('settings.get');

function merge(patch: OnboardingPatch): void {
  queryClient.setQueryData<Settings>(KEY, (prev) => (prev ? { ...prev, ...patch } : prev));
}

/** Resolves true when the core stored the patch. Never rejects. */
export async function saveOnboarding(patch: OnboardingPatch): Promise<boolean> {
  if (Object.keys(patch).length === 0) return true;
  merge(patch);
  try {
    const next = await rpc('settings.update', { patch });
    merge({
      ...('tourCompleted' in patch ? { tourCompleted: next.tourCompleted } : {}),
      ...('lastSeenVersion' in patch ? { lastSeenVersion: next.lastSeenVersion } : {}),
    });
    return true;
  } catch (err) {
    console.warn('[onboarding] could not store', patch, err);
    return false;
  }
}
