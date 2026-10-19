/**
 * The guide time shift fields of the source dialog (per source) and the mapping dialog (per
 * channel). Both are whole minutes within 12 hours either way, like `settings.epgOffsetMinutes`
 * (`epg::query::MAX_SHIFT_MINUTES` in the core).
 */

/** Largest per-source or per-channel guide shift, in minutes either way. */
export const MAX_GUIDE_SHIFT_MINUTES = 720;

/**
 * Minutes typed into a guide shift field: blank is 0, a whole number within the limit is
 * itself (a typographic minus counts as "-"), anything else is null.
 */
export function parseGuideShift(raw: string): number | null {
  const v = raw.trim().replace(/^−/, '-');
  if (v === '') return 0;
  if (!/^[+-]?\d+$/.test(v)) return null;
  const minutes = Number(v);
  return Math.abs(minutes) <= MAX_GUIDE_SHIFT_MINUTES ? minutes : null;
}
