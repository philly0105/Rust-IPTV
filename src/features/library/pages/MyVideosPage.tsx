/** /my-videos: the offline library of completed downloads. */

import { k } from '../lib/keys';
import { HardDriveDownload, ListOrdered } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';

import { joinList } from '@/shell/dashboard/cards';
import { buttonClass } from '@/ui/Button';

import { Button, EmptyState, ErrorState, SkeletonGrid, Tabs } from '../deps';
import { CARD_CAPTION_HEIGHT, LibraryCard } from '../components/LibraryCard';
import { RecordingCard } from '../components/RecordingCard';
import { PageTitle } from '../components/bits';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { useMyVideos } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatBytes } from '../lib/format';
import { buildLibrary, entryTargetId, filterLibrary, hasMissing, librarySize, withRecordings, type GridEntry, type LibraryFilter } from '../lib/myvideos';
// recording:
import { RecordingsPanel, usePlayRecording, useVisibleRecordingFiles } from '../components/RecordingsPanel';

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
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const query = useMyVideos();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const rawFilter = params.get('filter');
  const filter: LibraryFilter = isFilter(rawFilter) ? rawFilter : 'all';
  // recording:
  const showRecordings = rawFilter === 'recordings';

  const library = useMemo(() => buildLibrary(query.data ?? []), [query.data]);
  // recording: files in the recordings folder count toward the header, appear in All
  // (and Missing) beside the downloads, and have their own tab.
  const { query: recordingFiles, files } = useVisibleRecordingFiles();
  const everything = useMemo(() => withRecordings(library, files), [library, files]);
  const visible = useMemo(() => filterLibrary(everything, filter, search), [everything, filter, search]);
  const counts = useMemo(
    () => ({
      all: everything.length,
      movies: library.filter((e) => e.kind === 'movie').length,
      series: library.filter((e) => e.kind === 'series').length,
      missing: everything.filter(hasMissing).length,
    }),
    [everything, library],
  );
  const size = useMemo(() => librarySize(query.data ?? []), [query.data]);
  const recordings = useMemo(() => ({ count: files.length, bytes: files.reduce((n, f) => n + (f.fileAvailable ? f.sizeBytes : 0), 0) }), [files]);
  const playRecording = usePlayRecording();

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
        {/* Icon only on a phone, so the header keeps the palette and theme buttons on screen. */}
        <span className="max-sm:sr-only">{t('openQueue')}</span>
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
  } else if (query.isLoading || (filter === 'all' && recordingFiles.isLoading)) {
    // All waits for the recordings too, so they do not pop into a grid already on screen.
    body = <SkeletonGrid count={12} minColumnWidth={168} className="pt-2" />;
  } else if (query.isError) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (everything.length === 0) {
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
      <VirtualCardGrid<GridEntry>
        items={visible}
        itemKey={(e) => e.key}
        label={t('myVideosTitle')}
        cardLabel={(e) =>
          e.kind === 'recording'
            ? `${e.title}, ${t('recordingKind')}${e.missing ? `, ${t('fileMissing')}` : ''}`
            : e.kind === 'movie'
              ? `${e.title}${e.missing ? `, ${t('fileMissing')}` : ''}`
              : `${e.title}, ${t('episodeCount', { count: e.episodes.length })}${e.missingCount > 0 ? `, ${t('episodesMissingTitle', { count: e.missingCount })}` : ''}`
        }
        onActivate={(e) => {
          if (e.kind === 'recording') {
            // No detail page: an available file plays; a missing one opens the
            // Recordings tab, where it can be removed from the list.
            if (e.missing) setFilter('recordings');
            else void playRecording(e.file);
            return;
          }
          // The detail page's Back returns here, on the same tab and search.
          const qs = params.toString();
          navigate(`/my-videos/${entryTargetId(e)}`, { state: { back: `/my-videos${qs ? `?${qs}` : ''}` } });
        }}
        render={(e) => (e.kind === 'recording' ? <RecordingCard entry={e} /> : <LibraryCard entry={e} />)}
        captionHeight={CARD_CAPTION_HEIGHT}
        testId="my-videos-grid"
        // Back from a detail page (in-page or the browser's) lands on the same scroll and card.
        restoreKey={`my-videos:${location.key}`}
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
