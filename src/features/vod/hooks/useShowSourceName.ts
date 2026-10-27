import { useVisibleSources } from '@/shell/useVisibleSources';

/**
 * Whether a page names the source it shows: only when more than one source is set up. With one,
 * its name in every header subtitle, the landing's source line and the search placeholder told
 * the user nothing they could choose between (the rule round 1 used for Library's source column).
 * While the list loads it reads as one source, so a name never flashes in and out.
 */
export function useShowSourceName(): boolean {
  return (useVisibleSources().data?.length ?? 0) > 1;
}
