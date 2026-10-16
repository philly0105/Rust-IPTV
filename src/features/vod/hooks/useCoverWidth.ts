import { useEffect, useState } from 'react';

import type { CoverSize } from '@/api/types';

/** Minimum poster column width for each cover size, in px at 100 % scale. */
export const COVER_WIDTH: Record<CoverSize, number> = { small: 128, medium: 164, large: 212 };
/**
 * On a phone-width screen every size shrinks to this: three posters a row at 390px (L2-vod-7). The
 * grid there is about 286px wide (390 minus the 72px rail and the page padding), and 275px beside
 * a thin desktop scrollbar; 80px columns with the 16px gap fit three in either.
 */
export const NARROW_COVER_WIDTH = 80;
const NARROW_QUERY = '(max-width: 479px)';

const narrowNow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;

/** The minimum poster column width for the cover-size setting, smaller on a phone-width screen. */
export function useCoverWidth(size: CoverSize | undefined): number {
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, []);
  const width = (size && COVER_WIDTH[size]) || COVER_WIDTH.medium;
  return narrow ? Math.min(width, NARROW_COVER_WIDTH) : width;
}
