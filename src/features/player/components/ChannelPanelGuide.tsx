import { QueryClientContext } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { itemKey, type Channel, type EpgProgram, type ItemRef } from '@/api/types';
import { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
import { useNow } from '@/features/live/hooks/useNow';
import { useShortEpgEnabled, useShortEpgPreviews } from '@/features/live/hooks/useShortEpg';
import { archivePath, canBrowseArchive } from '@/features/live/lib/archive';
import { nowNextFrom } from '@/features/live/lib/epgMerge';
import { MINUTE } from '@/features/live/lib/epgTime';
import { needsFallback } from '@/features/live/lib/shortEpg';

import { useMediaStore } from '../media';
import { usePlayerStore } from '../store';

/**
 * Guide slice: the fullscreen channel panel's now line and its "Browse catch-up" action.
 * The player also renders outside the app shell (tests, a bare mount): without a query client
 * or router these parts render nothing instead of throwing.
 */
function useAppContext(): boolean {
  const inRouter = useInRouterContext();
  const client = useContext(QueryClientContext);
  return inRouter && !!client;
}

/** Rows per `epg.nowNext` request; visible rows are rounded out to this so scrolling reuses answers. */
const NOW_CHUNK = 20;

type NowFor = (ref: ItemRef) => EpgProgram | undefined;
const nothing: NowFor = () => undefined;

interface NowLinesProps {
  sourceId: string | undefined;
  first: number;
  last: number;
  rowAt(i: number): Channel | undefined;
  children(nowFor: NowFor): ReactNode;
}

/**
 * Hands a channel list's rows a lookup of the programme on now: XMLTV first, Xtream's short guide
 * where XMLTV has nothing. The source's rows get theirs with their pages (usePagedChannels).
 */
export function PanelNowLines(props: NowLinesProps) {
  return useAppContext() ? <NowLines {...props} /> : <>{props.children(nothing)}</>;
}

function NowLines({ sourceId, first, last, rowAt, children }: NowLinesProps) {
  const prefs = useDisplayPrefs();
  const now = useNow(30_000);
  const source = useRpcQuery('sources.get', { id: sourceId ?? '' }, { enabled: !!sourceId, staleTime: 5 * 60_000 });

  const from = Math.floor(first / NOW_CHUNK) * NOW_CHUNK;
  const to = (Math.floor(last / NOW_CHUNK) + 1) * NOW_CHUNK;
  const refs: ItemRef[] = [];
  for (let i = from; i < to; i++) {
    const c = rowAt(i);
    if (c) refs.push(c.ref);
  }
  // The rows show titles only: no descriptions (about half the bytes).
  const nowNext = useRpcQuery(
    'epg.nowNext',
    { refs, offsetMinutes: prefs.epgOffsetMinutes, withDescription: false },
    { enabled: refs.length > 0, staleTime: 60_000 },
  );

  const shortOn = useShortEpgEnabled(source.data?.kind);
  const data = nowNext.data;
  const fallbackKey = data ? refs.filter((r) => needsFallback(data[itemKey(r)])).map(itemKey).join('\n') : '';
  const fallbackRefs = useMemo(
    () => (data ? refs.filter((r) => needsFallback(data[itemKey(r)])) : []),
    // `fallbackKey` stands for the refs it lists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fallbackKey],
  );
  const shortFor = useShortEpgPreviews(sourceId ?? '', shortOn, fallbackRefs, now);
  const guideNow = now - prefs.epgOffsetMinutes * MINUTE;

  const nowFor = useCallback<NowFor>(
    (ref) => data?.[itemKey(ref)]?.now ?? (shortOn ? nowNextFrom(shortFor(ref), guideNow)?.now : undefined),
    [data, shortOn, shortFor, guideNow],
  );
  return <>{children(nowFor)}</>;
}

/** "Browse catch-up" for the playing channel: leaves fullscreen, closes the panel and opens the archive. */
export function PanelArchiveButton() {
  return useAppContext() ? <ArchiveButton /> : null;
}

function ArchiveButton() {
  const { t } = useTranslation('player');
  const navigate = useNavigate();
  const ref = usePlayerStore((s) => (s.source?.isLive ? s.source.ref : undefined));
  const live = !!ref && ref.contentType === 'live';
  const args = { ref: ref ?? { sourceId: '', contentType: 'live' as const, itemId: '' } };
  const item = useRpcQuery('catalog.item', args, { enabled: live, staleTime: 5 * 60_000 });
  const source = useRpcQuery('sources.get', { id: ref?.sourceId ?? '' }, { enabled: live, staleTime: 5 * 60_000 });
  const channel = item.data && 'isRadio' in item.data ? item.data : undefined;
  if (!ref || !channel || !canBrowseArchive(channel, source.data?.kind)) return null;

  const open = () => {
    useMediaStore.setState({ channelPanelOpen: false });
    const player = usePlayerStore.getState();
    if (player.isFullscreen) player.toggleFullscreen();
    if (player.isWindowFilled) player.toggleWindowFill();
    navigate(archivePath(ref));
  };
  return (
    <div className="border-t border-white/10 p-2">
      <button
        type="button"
        onClick={open}
        className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-body-sm text-on-glass-muted hover:bg-white/10 hover:text-on-glass pointer-coarse:h-11"
        data-testid="panel-browse-archive"
      >
        <CalendarClock className="size-4" aria-hidden />
        {t('browseArchive')}
      </button>
    </div>
  );
}
