import { useMemo, useState, type ReactNode, type RefObject } from 'react';

import { itemKey, sameRef, type ItemRef, type SeriesItem, type VodItem } from '@/api/types';
import { ErrorState, SectionHeader } from '@/ui';

import { useVodPage } from '../hooks/queries';
import { useNearViewport } from '../hooks/useNearViewport';
import { useRailCardWidth } from '../hooks/useRailCardWidth';
import { useWatchedLookup } from '../hooks/useWatched';
import { filterByRating, ratingFilterInCore, type GridQueryInput } from '../lib/paging';
import { myListTarget } from './PosterCard';
import { PosterRail, type RailCardProps } from './PosterRail';

/** Cards a catalog rail shows: a slice to browse, with See all for the rest. */
export const CATALOG_RAIL_LIMIT = 20;

/** Caption, gap and the track's padding under a rail card's artwork, for the placeholder's height. */
const RAIL_CHROME_PX = 76;

export interface CatalogRailProps {
  title: ReactNode;
  count?: ReactNode;
  seeAll?: { to: string; label?: ReactNode };
  /** The grid this rail is the first page of; the same arguments, so See all opens on a cached page. */
  input: GridQueryInput | undefined;
  /** The page's scroller: the rail mounts once it comes near its viewport. */
  rootRef: RefObject<HTMLElement | null>;
  card: (item: VodItem | SeriesItem, index: number, rail: RailCardProps, watched: boolean) => ReactNode;
  /** Mount at once instead of waiting to be scrolled near (the rails at the top of the page). */
  eager?: boolean;
  /** A title to leave out (the one whose detail page shows "More in <category>"). */
  exclude?: ItemRef | undefined;
}

/**
 * One poster rail of the Movies and Series landing (CB-VOD-LANDING): the first page of a grid, a
 * category or the whole section by rating. Until it nears the viewport it is a placeholder of the
 * rail's height, so the page keeps its length (scroll memory lands where it left) and asks the
 * catalog only for rails the user gets to. A rail whose grid turns out empty goes away.
 */
export function CatalogRail({ title, count, seeAll, input, rootRef, card, eager, exclude }: CatalogRailProps) {
  const [ref, near] = useNearViewport<HTMLDivElement>(rootRef);
  const cardWidth = useRailCardWidth();
  if (!eager && !near) {
    return (
      <section ref={ref} className="min-w-0" data-testid="vod-rail-placeholder">
        <SectionHeader title={title} count={count} seeAll={seeAll} className="mb-3" />
        <div aria-hidden style={{ height: Math.round(cardWidth * 1.5 + RAIL_CHROME_PX) }} />
      </section>
    );
  }
  return <CatalogRailBody title={title} count={count} seeAll={seeAll} input={input} card={card} cardWidth={cardWidth} exclude={exclude} />;
}

function CatalogRailBody({
  title,
  count,
  seeAll,
  input,
  card,
  cardWidth,
  exclude,
}: Omit<CatalogRailProps, 'rootRef' | 'eager'> & { cardWidth: number }) {
  const page = useVodPage(input, 0);
  // Stalker portals filter neither by rating nor by watched, so the rail drops what the grid
  // would drop on its loaded pages: titles under the minimum rating and, with Hide watched, the
  // watched ones. Those go before the rail takes its slice, once their lookup has answered.
  const portal = !!input && !ratingFilterInCore(input.sourceKind);
  const hideWatched = portal && input?.hideWatched === true;
  const candidates = useMemo(() => {
    const list = page.data?.items ?? [];
    const rated = portal && input?.minRating ? filterByRating(list, input.minRating) : list;
    const kept = exclude ? rated.filter((i) => !sameRef(i.ref, exclude)) : rated;
    return hideWatched ? kept : kept.slice(0, CATALOG_RAIL_LIMIT);
  }, [page.data, portal, input?.minRating, exclude, hideWatched]);
  const lookup = useWatchedLookup(candidates);
  const watched = lookup.keys;
  const items = useMemo(
    () => (hideWatched ? candidates.filter((i) => !watched.has(itemKey(i.ref))).slice(0, CATALOG_RAIL_LIMIT) : candidates),
    [candidates, hideWatched, watched],
  );
  const checking = hideWatched && !lookup.settled;
  // A retry clears the error state until the next answer.
  const [retrying, setRetrying] = useState(false);
  if (page.isSuccess && !checking && items.length === 0) return null;
  return (
    <PosterRail<VodItem | SeriesItem>
      title={title}
      count={count}
      seeAll={seeAll}
      items={items}
      loading={!input || page.isPending || retrying || checking}
      cardWidth={cardWidth}
      bleed
      empty={
        page.isError ? (
          <ErrorState
            size="inline"
            error={page.error}
            onRetry={() => {
              setRetrying(true);
              void page.refetch().finally(() => setRetrying(false));
            }}
          />
        ) : undefined
      }
      myList={myListTarget}
      render={(item, i, rail) => card(item, i, rail, watched.has(itemKey(item.ref)))}
    />
  );
}
