import type { ReactNode } from 'react';

import type { TmdbBrief } from '@/api/types';

import { PosterCard } from './PosterCard';
import { PosterRail } from './PosterRail';

/** Search link for a TMDB title inside one source (or globally when no source). */
export function searchHref(title: string, sourceId?: string): string {
  const q = new URLSearchParams({ q: title }).toString();
  return sourceId ? `/s/${encodeURIComponent(sourceId)}/search?${q}` : `/search?${q}`;
}

/** TMDB titles (similar, known for). They are not catalog items, so each links into search for its title. */
export function TmdbRail({
  title,
  items,
  loading,
  sourceId,
  empty,
}: {
  title: ReactNode;
  items: TmdbBrief[];
  loading?: boolean;
  sourceId?: string;
  empty?: ReactNode;
}) {
  return (
    <PosterRail<TmdbBrief>
      title={title}
      items={items}
      loading={loading}
      empty={empty}
      render={(b, i) => (
        <PosterCard index={i} title={b.title} href={searchHref(b.title, sourceId)} posterUrl={b.posterUrl} year={b.year} rating={b.rating} />
      )}
    />
  );
}
