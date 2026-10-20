import type { CoverSize } from '@/api/types';
import { useMediaQuery } from '@/features/live/hooks/useMediaQuery';
import { useSettings } from '@/shell/useSettings';
import { useScaledPx } from '@/ui/scale';

// Direct imports, not the slice's deps: My List's grid uses this too, and the deps barrel would
// pull the shell layout and the player into every module that imports My List.

/**
 * Poster column width per cover size, as the VOD grids use it (VL-page-rhythm): one setting sizes
 * every poster grid in the app (My Videos, My List). On a phone-width screen three posters fit a
 * row, with the grids' 16 px gap (POSTER_GAP), as in a category grid.
 */
export const POSTER_GAP = 16;
const COVER_COLUMN: Record<CoverSize, number> = { small: 128, medium: 164, large: 212 };
const NARROW_COLUMN = 80;

/** The minimum poster column width for the cover-size setting, in px at the current UI scale. */
export function useCoverColumn(): number {
  const size = useSettings().data?.coverSize ?? 'medium';
  const narrow = useMediaQuery('(max-width: 479px)', false);
  return useScaledPx(narrow ? NARROW_COLUMN : (COVER_COLUMN[size] ?? COVER_COLUMN.medium), true);
}
