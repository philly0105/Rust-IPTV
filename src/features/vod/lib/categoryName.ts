import type { VodKind } from './paging';

/** Leading words a provider puts before its VOD groups that only repeat the section's name. */
const SECTION_PREFIX: Record<VodKind, RegExp> = {
  movie: /^\s*(?:movies?|films?|vod)\s*[|:\-–]\s*/i,
  series: /^\s*(?:series|tv series|tv shows?|vod)\s*[|:\-–]\s*/i,
};

/**
 * A category's name as the Movies or Series pages show it: "Movies | Action" reads "Action" on the
 * Movies page, where every chip and rail repeated the section. Only a leading section word followed
 * by "|", ":" or "-" goes, and only when something is left; a country or language tag ("EN |") stays.
 * Tooltips, search and accessible names keep the provider's name.
 */
export function sectionlessCategoryName(name: string, kind: VodKind): string {
  const rest = name.replace(SECTION_PREFIX[kind], '');
  return rest.trim() ? rest : name;
}
