/** /my-videos: the offline library of completed downloads. */

import { k } from '../lib/keys';
import { HardDriveDownload, ListOrdered } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';

import { joinList } from '@/shell/dashboard/cards';
import { buttonClass } from '@/ui/Button';

import { CARD_ROOT } from '@/ui/card';
import { cn } from '@/ui/cn';

import { Button, EmptyState, ErrorState, Page, SkeletonGrid, Tabs, useEdgeFades, type TabsProps } from '../deps';
import { moveInRail } from '../components/ContinueRail';
import { CARD_CAPTION_HEIGHT, LibraryCard } from '../components/LibraryCard';
import { RecordingCard } from '../components/RecordingCard';
import { PageTitle } from '../components/bits';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { useActiveDownloads } from '../hooks/useActiveDownloads';
import { POSTER_GAP, useCoverColumn } from '../hooks/useCoverColumn';
import { useMyVideos } from '../hooks/useLibraryData';
import { usePageHeader } from '../hooks/usePageHeader';
import { formatBytes } from '../lib/format';
import {
  buildLibrary,
  entryTargetId,
  filterLibrary,
  hasMissing,
  librarySize,
  withRecordings,
  type GridEntry,
  type LibraryEntry,
  type LibraryFilter,
  type RecordingEntry,
} from '../lib/myvideos';
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
  // Recordings are TV: wide cards in a section of their own above the posters, not 2:3 tiles in
  // the poster grid.
  const visibleRecordings = useMemo(() => visible.filter((e): e is RecordingEntry => e.kind === 'recording'), [visible]);
  const visibleTitles = useMemo(() => visible.filter((e): e is LibraryEntry => e.kind !== 'recording'), [visible]);
  const column = useCoverColumn();
  const active = useActiveDownloads();
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

  // An empty library says so in the page; "0 titles, 0 B" above it adds nothing (L3-visual-11).
  const subtitle =
    query.data && (library.length > 0 || recordings.count > 0)
    ? librarySubtitle({
        titles: library.length,
        recordings: recordings.count,
        size: formatBytes(size + recordings.bytes, i18n.language) || '0 B',
        lang: i18n.language,
        t,
      })
    : undefined;
  // In the page's toolbar beside the tabs, not the header, so the header search keeps its place
  // from page to page. The count says what is moving now. On a phone the tabs take the whole row
  // and the link goes under them, with its label (there is room for it there).
  const queueLink = (
    <Link to="/downloads" className={buttonClass('ghost', 'sm', 'shrink-0 sm:ms-auto max-sm:-ms-3')} data-testid="my-videos-queue">
      <ListOrdered size={16} aria-hidden />
      <span>{t('openQueue')}</span>
      {active.active > 0 ? (
        <span className="tabular rounded-full bg-surface-3 px-1.5 text-xs text-fg-muted" data-testid="my-videos-queue-count">
          <span className="sr-only">, </span>
          {active.active}
        </span>
      ) : null}
    </Link>
  );
  const libraryEmpty = !!query.data && !!recordingFiles.data && everything.length === 0 && !showRecordings && !search && filter === 'all';
  const title = t('myVideosTitle');
  usePageHeader(title, subtitle, undefined, { value: search, onChange: onSearch, placeholder: t('searchLibrary') });

  const openEntry = (e: GridEntry) => {
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
  };

  let body;
  // recording:
  if (showRecordings) {
    body = <RecordingsPanel search={search} />;
  } else if (query.isLoading || (filter === 'all' && recordingFiles.isLoading)) {
    // All waits for the recordings too, so they do not pop into a grid already on screen.
    body = <SkeletonGrid count={12} minColumnWidth={column} className="pt-2" />;
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
    const recordingCardLabel = (e: RecordingEntry) => `${e.title}, ${t('recordingKind')}${e.missing ? `, ${t('fileMissing')}` : ''}`;
    let header: ReactNode = null;
    if (visibleRecordings.length > 0) {
      header = (
        <div className="flex flex-col gap-6 pb-4">
          <RecordingsRail entries={visibleRecordings} cardLabel={recordingCardLabel} onOpen={openEntry} />
          {visibleTitles.length > 0 ? (
            <div className="flex items-baseline gap-3">
              <h2 className="text-title-sm text-fg">{t('myVideosTitlesHeading')}</h2>
              <span className="text-body-sm tabular-nums text-fg-subtle">{visibleTitles.length}</span>
            </div>
          ) : null}
        </div>
      );
    }
    body = (
      <VirtualCardGrid<LibraryEntry>
        items={visibleTitles}
        itemKey={(e) => e.key}
        label={t('myVideosTitle')}
        cardLabel={(e) =>
          e.kind === 'movie'
            ? `${e.title}${e.missing ? `, ${t('fileMissing')}` : ''}`
            : `${e.title}, ${t('episodeCount', { count: e.episodes.length })}${e.missingCount > 0 ? `, ${t('episodesMissingTitle', { count: e.missingCount })}` : ''}`
        }
        onActivate={openEntry}
        render={(e) => <LibraryCard entry={e} />}
        postersFillCells
        captionHeight={CARD_CAPTION_HEIGHT}
        minColumnWidth={column}
        gap={POSTER_GAP}
        header={header}
        testId="my-videos-grid"
        // Back from a detail page (in-page or the browser's) lands on the same scroll and card.
        restoreKey={`my-videos:${location.key}`}
      />
    );
  }

  return (
    <Page width="wide" className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 pb-4">
      <PageTitle>{title}</PageTitle>
      {/* An empty library shows its empty state alone: tabs of zeros and a second queue link add nothing. */}
      {libraryEmpty ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <FadingTabs
            label={t('filterLabel')}
            value={showRecordings ? 'recordings' : filter}
            onChange={setFilter}
            items={[
              ...FILTERS.filter((f) => f !== 'missing' || counts.missing > 0).map((f) => ({
                id: f,
                label: t(k('filter', f)),
                badge: <span className="tabular-nums">{counts[f]}</span>,
              })),
              // recording:
              {
                id: 'recordings',
                label: t('filterRecordings'),
                ...(recordingFiles.data ? { badge: <span className="tabular-nums">{recordings.count}</span> } : {}),
              },
            ]}
          />
          {queueLink}
        </div>
      )}
      {body}
    </Page>
  );
}

export default MyVideosPage;

/**
 * The filter tabs as a pill strip that fits its content, and on a phone takes the whole row. When
 * the tabs still do not fit (a phone, a long locale, the Missing tab), the strip scrolls sideways
 * and the edge that hides tabs fades out, so a cut tab reads as more this way rather than as the
 * end; a mouse wheel scrolls it too. The fade is drawn on the wrapper, which has the strip's box.
 */
function FadingTabs({ items, ...props }: Pick<TabsProps, 'items' | 'value' | 'onChange' | 'label'>) {
  const { i18n } = useTranslation('library');
  const fades = useEdgeFades(`${items.map((i) => i.id).join(',')}|${i18n.language}`);
  const { ref } = fades;
  const attach = useCallback((el: HTMLDivElement | null) => ref(el?.querySelector<HTMLElement>('[role="tablist"]') ?? null), [ref]);
  return (
    <div ref={attach} style={fades.style} className="min-w-0 max-sm:w-full" data-testid="my-videos-tabs">
      <Tabs variant="pill" className="w-fit min-w-0" items={items} {...props} />
    </div>
  );
}

/**
 * The recordings in All (and Missing): a sideways rail of wide cards with its own heading. Each
 * card is a button; arrows walk the rail, as on Recently watched's Continue rail.
 */
function RecordingsRail({
  entries,
  cardLabel,
  onOpen,
}: {
  entries: readonly RecordingEntry[];
  cardLabel: (e: RecordingEntry) => string;
  onOpen: (e: RecordingEntry) => void;
}) {
  const { t } = useTranslation('library');
  return (
    <section aria-labelledby="my-videos-recordings" className="flex flex-col gap-3" data-testid="my-videos-recordings">
      <div className="flex items-baseline gap-3">
        <h2 id="my-videos-recordings" className="text-title-sm text-fg">
          {t('filterRecordings')}
        </h2>
        <span className="text-body-sm tabular-nums text-fg-subtle">{entries.length}</span>
      </div>
      <ul aria-label={t('filterRecordings')} className="-mx-1 flex snap-x scroll-px-1 gap-4 overflow-x-auto px-1 pt-1 pb-2">
        {entries.map((e) => (
          <li key={e.key} className="w-[17rem] shrink-0 snap-start max-sm:w-[14rem]">
            <button
              type="button"
              aria-label={cardLabel(e)}
              data-recording-open=""
              onClick={() => onOpen(e)}
              onKeyDown={(ev) => {
                if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
                if (moveInRail(ev.currentTarget, ev.key, '[data-recording-open]')) ev.preventDefault();
              }}
              className={cn(CARD_ROOT, 'block w-full cursor-pointer text-start')}
            >
              <RecordingCard entry={e} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
