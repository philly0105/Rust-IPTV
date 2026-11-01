import type { ContentType, Source } from '@/api/types';

/** How many items of each content type a source has. */
export function contentCounts(source: Source): Record<ContentType, number> {
  return {
    live: source.channelCount,
    radio: typeof source.radioCount === 'number' ? source.radioCount : 0,
    movie: source.movieCount,
    series: source.seriesCount,
  };
}
