import type { ReactNode } from 'react';

import type { TmdbBrief } from '@/api/types';

import { useSearchPrefetchIntent } from '../hooks/prefetch';
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
      render={(b, i) => <TmdbCard brief={b} index={i} sourceId={sourceId} />}
    />
  );
}

/** One TMDB title; resting on it warms the search page it links to (C4). */
function TmdbCard({ brief, index, sourceId }: { brief: TmdbBrief; index: number; sourceId: string | undefined }) {
  const intent = useSearchPrefetchIntent({ title: brief.title, sourceId });
  return (
    <PosterCard
      index={index}
      title={brief.title}
      href={searchHref(brief.title, sourceId)}
      posterUrl={brief.posterUrl}
      year={brief.year}
      rating={brief.rating}
      intent={intent}
    />
  );
}
