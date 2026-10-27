/**
 * /stats (contract C7): watch time over the last 7 or 30 days, a per-day
 * chart split into live and movies/series, the most-watched channels and
 * titles, and Clear stats behind a confirm.
 *
 * The range lives in the URL (`?range=30`; 7 is the default and has no
 * parameter); `7` and `3` switch it from the keyboard. Everything is counted
 * on this device by the playback reporter (../reporter.ts).
 */

import { ChartColumn, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import type { WatchStatsTop } from '@/api/types';

import { DayChart, LIVE_FILL, VOD_FILL } from '../components/DayChart';
import { StatsSkeleton } from '../components/StatsSkeleton';
import { TopChannels, TopTitles } from '../components/TopList';
import { Button, Dialog, EmptyState, ErrorState, Page, Tabs, buttonClass, cn, playItem, useShell, useShortcut, useToast, useVisibleSources, errorDescription } from '../deps';
import { useClearStats, useMonthHasData, useWatchStats } from '../hooks/useWatchStats';
import { rangeTotals } from '../lib/chart';
import { formatWatchTime } from '../lib/format';
import { readRange, type StatsRange } from '../paths';

export function StatsPage() {
  const { t, i18n } = useTranslation('stats');
  const lang = i18n.language;
  const { toast } = useToast();
  const { setHeader } = useShell();
  const title = t('title');
  useEffect(() => {
    setHeader({ title });
  }, [setHeader, title]);

  const [params, setParams] = useSearchParams();
  const range = readRange(params.get('range'));
  const setRange = useCallback(
    (next: StatsRange) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === 30) p.set('range', '30');
          else p.delete('range');
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  useShortcut('7', () => setRange(7), { description: t('showWeek'), area: title });
  useShortcut('3', () => setRange(30), { description: t('showMonth'), area: title });

  const { query, today } = useWatchStats(range);
  const data = query.data;
  const sources = useVisibleSources();
  const weekEmpty = range === 7 && data?.totalSeconds === 0;
  const monthHasData = useMonthHasData(weekEmpty, today);
  const firstSource = sources.data?.[0];
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);

  const play = (item: WatchStatsTop) => {
    const source = sourceById.get(item.ref.sourceId);
    if (!source) return;
    playItem({
      ref: item.ref,
      title: item.title,
      ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
      isLive: true,
      isRadio: item.ref.contentType === 'radio',
      sourceKind: source.kind,
    }).catch((err: unknown) => {
      toast({ variant: 'error', title: t('playFailed', { title: item.title }), description: errorDescription(err) });
    });
  };

  const [confirming, setConfirming] = useState(false);
  const clear = useClearStats();
  const confirmClear = () =>
    clear.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        toast({ variant: 'success', title: t('cleared') });
      },
      onError: (err) => toast({ variant: 'error', title: t('clearFailed'), description: errorDescription(err) }),
    });

  const time = (s: number) => formatWatchTime(s, lang);
  // With nothing watched in either range, 7 days and 30 days would only switch between two empty
  // pages: the range stays away until there is something to compare (it shows again while a week
  // is empty but the month is not). Also while an empty week waits to hear about the month, so it
  // does not show and then vanish.
  const nothingToRange = data?.totalSeconds === 0 && !(range === 7 && monthHasData === true);

  let headline = null;
  let body;
  if (query.isPending || (weekEmpty && monthHasData === null)) {
    body = <StatsSkeleton label={t('loading')} />;
  } else if (!data) {
    body = <ErrorState error={query.error} hint={t('errorHint')} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else if (data.totalSeconds === 0) {
    // "Show 30 days" only when that range has something; with nothing watched at all, point at something to watch.
    const olderData = range === 7 && monthHasData === true;
    body = (
      <EmptyState
        icon={<ChartColumn size={28} aria-hidden />}
        title={t('emptyTitle')}
        description={olderData ? t('emptyWeek') : t('emptyMonth')}
        action={
          olderData ? (
            <Button onClick={() => setRange(30)} data-testid="stats-show-month">
              {t('showMonth')}
            </Button>
          ) : firstSource ? (
            <Link to={`/s/${encodeURIComponent(firstSource.id)}/live`} className={buttonClass('primary')} data-testid="stats-watch-live">
              {t('watchLive')}
            </Link>
          ) : (
            <Link to="/dashboard" className={buttonClass('secondary')} data-testid="stats-go-home">
              {t('goHome')}
            </Link>
          )
        }
      />
    );
  } else {
    const split = rangeTotals(data.days);
    // KPI tiles (critique: stats): the total leads, then the split (which doubles as the chart's
    // legend) and the daily average, each a number with its label rather than one long sentence.
    // From lg one row across the page, the total a little wider and the other three equal (the
    // split's list is a subgrid, so its tiles take the row's own columns).
    const tile = 'flex min-w-0 flex-col justify-between gap-1 rounded-lg border border-edge bg-surface px-4 py-3';
    headline = (
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]" data-testid="stats-kpis">
        <div className={tile} data-testid="stats-total">
          {/* Read as one sentence ("3 hr 20 min watched in the last 7 days"); drawn as a number over its label. */}
          <span className="sr-only">{t(range === 7 ? 'totalWeek' : 'totalMonth', { time: time(data.totalSeconds) })}</span>
          <span aria-hidden className="text-headline tabular-nums text-fg sm:text-[calc(36rem/15)]">
            {time(data.totalSeconds)}
          </span>
          <span aria-hidden className="text-body-sm text-fg-muted">
            {t(range === 7 ? 'kpiWeek' : 'kpiMonth')}
          </span>
        </div>
        <ul className="grid min-w-0 grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-subgrid" data-testid="stats-split">
          <li className={tile}>
            <span className="flex items-center gap-2 text-body-sm text-fg-muted">
              <span aria-hidden className={cn('size-2.5 rounded-[3px]', LIVE_FILL)} />
              {t('live')}
            </span>{' '}
            <span className="text-title tabular-nums text-fg">{time(split.live)}</span>
          </li>
          <li className={tile}>
            <span className="flex items-center gap-2 text-body-sm text-fg-muted">
              <span aria-hidden className={cn('size-2.5 rounded-[3px]', VOD_FILL)} />
              {t('vod')}
            </span>{' '}
            <span className="text-title tabular-nums text-fg">{time(split.vod)}</span>
          </li>
        </ul>
        <div className={cn(tile, 'sm:col-span-2 lg:col-span-1')} data-testid="stats-average">
          <span className="text-body-sm text-fg-muted">{t('dailyAverage')}</span>{' '}
          <span className="text-title tabular-nums text-fg">{time(Math.round(data.totalSeconds / Math.max(1, data.days.length)))}</span>
        </div>
      </div>
    );
    body = (
      <div className="flex flex-col gap-8">
        <DayChart days={data.days} today={today} />
        <div className="grid gap-8 md:grid-cols-2">
          <TopChannels items={data.topChannels} canPlay={(item) => sourceById.has(item.ref.sourceId)} onPlay={play} />
          <TopTitles items={data.topTitles} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider pt-4">
          <p className="text-sm text-fg-subtle">{t('localNote')}</p>
          <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden />} onClick={() => setConfirming(true)} data-testid="stats-clear">
            {t('clear')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Page width="default" className="flex min-w-0 flex-col gap-6 pb-10" data-testid="stats-page">
      {/* C16: the page's single h1; the shell header shows the same text as a paragraph. */}
      <h1 className="sr-only">{title}</h1>
      {/* The range sets everything below it, so it leads on its own line, and the KPI row keeps
          the page's full width and one right edge (it used to sit at the row's end, half as tall
          as the tiles beside it). */}
      {nothingToRange ? null : (
        <div className="flex flex-col gap-4">
          <Tabs
            className="self-start"
            variant="pill"
            label={t('range')}
            value={String(range)}
            onChange={(id) => setRange(readRange(id))}
            items={[
              { id: '7', label: t('week') },
              { id: '30', label: t('month') },
            ]}
          />
          {headline}
        </div>
      )}
      {body}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('clearTitle')}
        description={t('clearBody')}
        size="sm"
        testId="stats-clear-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </Button>
            <Button variant="danger" loading={clear.isPending} onClick={confirmClear} data-testid="stats-clear-confirm">
              {t('clear')}
            </Button>
          </>
        }
      />
    </Page>
  );
}

export default StatsPage;
