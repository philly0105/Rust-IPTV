/** /my-videos: the offline library of completed downloads. */

import { k } from '../lib/keys';
import { HardDriveDownload, ListOrdered } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { joinList } from '@/shell/dashboard/cards';
import { buttonClass } from '@/ui/Button';

import { Button, EmptyState, ErrorState, SkeletonGrid, Tabs } from '../deps';
import { CARD_CAPTION_HEIGHT, LibraryCard } from '../components/LibraryCard';
import { PageTitle } from '../components/bits';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { useMyVideos } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatBytes } from '../lib/format';
import { buildLibrary, entryTargetId, filterLibrary, librarySize, type LibraryFilter } from '../lib/myvideos';
// recording:
import { RecordingsPanel, useRecordingFiles } from '../components/RecordingsPanel';

const FILTERS: readonly LibraryFilter[] = ['all', 'movies', 'series', 'missing'];

function isFilter(v: string | null): v is LibraryFilter {
  return v !== null && (FILTERS as readonly string[]).includes(v);
}

export { entryTargetId };

/**
 * Header line: titles, recordings (when there are any) and their size on
 * disk, joined with the locale's separator ("8 titles, 3 recordings, 94.6 MB"). With no
 * downloads but some recordings, the titles part drops out.
 */
export function librarySubtitle({
  titles,
  recordings,
  size,
  lang,
  t,
}: {
  titles: number;
  recordings: number;
  size: string;
  lang: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
}): string {
  const parts: string[] = [];
  if (titles > 0 || recordings === 0) parts.push(t('libraryTitleCount', { count: titles }));
  if (recordings > 0) parts.push(t('libraryRecordingCount', { count: recordings }));
  parts.push(size);
  return joinList(parts, lang);
}

export function MyVideosPage() {
  const { t, i18n } = useTranslation('library');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = useMyVideos();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const rawFilter = params.get('filter');
  const filter: LibraryFilter = isFilter(rawFilter) ? rawFilter : 'all';
  // recording:
  const showRecordings = rawFilter === 'recordings';

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
  // recording: files in the recordings folder count toward the header and get their own tab badge.
  const recordingFiles = useRecordingFiles();
  const recordings = useMemo(() => {
    const files = recordingFiles.data ?? [];
    return { count: files.length, bytes: files.reduce((n, f) => n + (f.fileAvailable ? f.sizeBytes : 0), 0) };
  }, [recordingFiles.data]);

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

  const subtitle = query.data
    ? librarySubtitle({
        titles: library.length,
        recordings: recordings.count,
        size: formatBytes(size + recordings.bytes, i18n.language) || '0 B',
        lang: i18n.language,
        t,
      })
    : undefined;
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
  // recording:
  if (showRecordings) {
    body = <RecordingsPanel search={search} />;
  } else if (query.isLoading) {
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
        onActivate={(e) => {
          // The detail page's Back returns here, on the same tab and search.
          const qs = params.toString();
          navigate(`/my-videos/${entryTargetId(e)}`, { state: { back: `/my-videos${qs ? `?${qs}` : ''}` } });
        }}
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
        value={showRecordings ? 'recordings' : filter}
        onChange={setFilter}
        items={[
          ...FILTERS.filter((f) => f !== 'missing' || counts.missing > 0).map((f) => ({
            id: f,
            label: t(k('filter', f)),
            badge: <span className="font-display tabular-nums">{counts[f]}</span>,
          })),
          // recording:
          {
            id: 'recordings',
            label: t('filterRecordings'),
            ...(recordingFiles.data ? { badge: <span className="font-display tabular-nums">{recordings.count}</span> } : {}),
          },
        ]}
      />
      {body}
    </div>
  );
}

export default MyVideosPage;
