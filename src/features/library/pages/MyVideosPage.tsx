/** /my-videos: the offline library of completed downloads. */

import { k } from '../lib/keys';
import { HardDriveDownload, ListOrdered } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { buttonClass } from '@/ui/Button';

import { Button, EmptyState, ErrorState, SkeletonGrid, Tabs } from '../deps';
import { CARD_CAPTION_HEIGHT, LibraryCard } from '../components/LibraryCard';
import { PageTitle } from '../components/bits';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { useMyVideos } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatBytes } from '../lib/format';
import { buildLibrary, entryTargetId, filterLibrary, librarySize, type LibraryFilter } from '../lib/myvideos';

const FILTERS: readonly LibraryFilter[] = ['all', 'movies', 'series', 'missing'];

function isFilter(v: string | null): v is LibraryFilter {
  return v !== null && (FILTERS as readonly string[]).includes(v);
}

export { entryTargetId };

export function MyVideosPage() {
  const { t, i18n } = useTranslation('library');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = useMyVideos();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const rawFilter = params.get('filter');
  const filter: LibraryFilter = isFilter(rawFilter) ? rawFilter : 'all';

  const library = useMemo(() => buildLibrary(query.data ?? []), [query.data]);
  const visible = useMemo(() => filterLibrary(library, filter, search), [library, filter, search]);
  const counts = useMemo(
    () => ({
      all: library.length,
      movies: library.filter((e) => e.kind === 'movie').length,
      series: library.filter((e) => e.kind === 'series').length,
      missing: library.filter((e) => (e.kind === 'movie' ? e.missing : e.missingCount > 0)).length,
    }),
    [library],
  );
  const size = useMemo(() => librarySize(query.data ?? []), [query.data]);

  const setFilter = (f: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (f === 'all') next.delete('filter');
        else next.set('filter', f);
        return next;
      },
      { replace: true },
    );
  };

  const onSearch = useMemo(
    () => (v: string) => {
      setSearch(v);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v) next.set('q', v);
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const subtitle = query.data ? t('librarySummary', { count: library.length, size: formatBytes(size, i18n.language) || '0 B' }) : undefined;
  const headerActions = useMemo(
    () => (
      <Link to="/downloads" className={buttonClass('ghost', 'sm')}>
        <ListOrdered size={16} aria-hidden />
        {t('openQueue')}
      </Link>
    ),
    [t],
  );
  const title = t('myVideosTitle');
  usePageHeader(title, subtitle, headerActions, { value: search, onChange: onSearch, placeholder: t('searchLibrary') });

  let body;
  if (query.isLoading) {
    body = <SkeletonGrid count={12} minColumnWidth={168} className="pt-2" />;
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (library.length === 0) {
    body = (
      <EmptyState
        icon={<HardDriveDownload size={28} aria-hidden />}
        title={t('libraryEmptyTitle')}
        description={t('libraryEmptyBody')}
        action={
          <Link to="/downloads" className={buttonClass('secondary', 'md')}>
            {t('openQueue')}
          </Link>
        }
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        title={t('noMatchTitle')}
        description={search ? t('noMatchSearch', { query: search }) : t('noMatchFilter')}
        action={
          <Button
            onClick={() => {
              onSearch('');
              setFilter('all');
            }}
          >
            {t('clearFilters')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <VirtualCardGrid
        items={visible}
        itemKey={(e) => e.key}
        label={t('myVideosTitle')}
        cardLabel={(e) =>
          e.kind === 'movie'
            ? `${e.title}${e.missing ? `, ${t('fileMissing')}` : ''}`
            : `${e.title}, ${t('episodeCount', { count: e.episodes.length })}${e.missingCount > 0 ? `, ${t('episodesMissingTitle', { count: e.missingCount })}` : ''}`
        }
        onActivate={(e) => navigate(`/my-videos/${entryTargetId(e)}`)}
        render={(e) => <LibraryCard entry={e} />}
        captionHeight={CARD_CAPTION_HEIGHT}
        testId="my-videos-grid"
      />
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-var(--header-height))] w-full max-w-[2200px] min-w-0 flex-col gap-4 px-6 pb-4 pt-4">
      <PageTitle>{title}</PageTitle>
      <Tabs
        variant="pill"
        label={t('filterLabel')}
        value={filter}
        onChange={setFilter}
        items={FILTERS.filter((f) => f !== 'missing' || counts.missing > 0).map((f) => ({
          id: f,
          label: t(k('filter', f)),
          badge: <span className="font-display tabular-nums">{counts[f]}</span>,
        }))}
      />
      {body}
    </div>
  );
}

export default MyVideosPage;
